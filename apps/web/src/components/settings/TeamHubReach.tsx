import { useAtomValue } from "@effect/atom-react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { readTeamHubNetworkState } from "@t3tools/client-runtime/state/team-hub";
import {
  TeamHubNetworkState,
  TeamHubReachability,
  type TeamHubExposure,
  type TeamHubNetworkInput,
} from "@t3tools/contracts/teamHub";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { teamHubActionCommand } from "~/state/teamHub";
import { useAtomCommand } from "~/state/use-atom-command";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import {
  DEFAULT_HUB_PORT,
  DEFAULT_SHARE_PORT,
  isTailscaleShareUrl,
  presentNetworkState,
  presentReachability,
  servePortOfUrl,
  type ReachPresentation,
} from "./TeamHubReach.logic";

const isNetworkState = Schema.is(TeamHubNetworkState);
const isReachability = Schema.is(TeamHubReachability);

const TONE_ICON = {
  info: InfoIcon,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
  error: CircleAlertIcon,
} as const;

const REQUEST_FAILED = "The request to this server failed. Check the connection and try again.";

/** One presentation, rendered the same way wherever the hub's reachability comes up. */
function ReachNotice({
  presentation,
  busy = false,
  onRetry,
  onShare,
  onUsePort,
  children,
}: {
  presentation: ReachPresentation;
  busy?: boolean;
  onRetry: () => void;
  onShare?: () => void;
  onUsePort?: (servePort: number) => void;
  children?: ReactNode;
}) {
  const { copyToClipboard } = useCopyToClipboard<void>({
    onCopy: () => toastManager.add({ type: "success", title: "Copied" }),
    onError: (error) =>
      toastManager.add({ type: "error", title: "Could not copy", description: error.message }),
  });
  const Icon = TONE_ICON[presentation.tone];
  const command = presentation.actions.find((action) => action.kind === "copy");
  return (
    <Alert variant={presentation.tone}>
      <Icon />
      <AlertTitle>{presentation.title}</AlertTitle>
      <AlertDescription>
        {presentation.detail ? <p>{presentation.detail}</p> : null}
        {children}
        {command ? (
          <Input
            readOnly
            size="sm"
            font="mono"
            aria-label="Command"
            value={command.value}
            onFocus={(event) => event.target.select()}
          />
        ) : null}
        {presentation.actions.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {presentation.actions.map((action) => {
              switch (action.kind) {
                case "link":
                  return (
                    <Button
                      key={action.label}
                      size="xs"
                      variant="outline"
                      render={<a href={action.href} target="_blank" rel="noreferrer noopener" />}
                    >
                      {action.label}
                    </Button>
                  );
                case "retry":
                  return (
                    <Button
                      key={action.label}
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={onRetry}
                    >
                      {action.label}
                    </Button>
                  );
                case "share":
                  return (
                    <Button key={action.label} size="xs" disabled={busy} onClick={onShare}>
                      {busy ? (
                        <>
                          <Spinner size="sm" />
                          Sharing…
                        </>
                      ) : (
                        action.label
                      )}
                    </Button>
                  );
                case "use-port":
                  return (
                    <Button
                      key={action.label}
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => onUsePort?.(action.servePort)}
                    >
                      {action.label}
                    </Button>
                  );
                case "copy":
                  return (
                    <Button
                      key={action.label}
                      size="xs"
                      variant="outline"
                      onClick={() => copyToClipboard(action.value)}
                    >
                      {action.label}
                    </Button>
                  );
              }
            })}
          </div>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/**
 * Reads where a hub on this machine stands on Tailscale and runs the share and
 * stop actions. A result the server just returned is shown until the next read
 * replaces it, so a refused command stays visible instead of flickering back to
 * the state the re-read finds.
 */
function useHubNetwork(prepared: PreparedConnection, input: TeamHubNetworkInput) {
  const { hubPort, servePort, exposure } = input;
  const query = useMemo(
    () =>
      connectionAtomRuntime
        .atom(readTeamHubNetworkState(prepared, { hubPort, servePort, exposure }))
        .pipe(
          Atom.swr({ staleTime: 15_000, revalidateOnMount: true }),
          Atom.withLabel("team-hub-network"),
        ),
    [prepared, hubPort, servePort, exposure],
  );
  const state = Option.getOrNull(AsyncResult.value(useAtomValue(query)));
  const command = useAtomCommand(teamHubActionCommand, { reportFailure: false });
  const [override, setOverride] = useState<{
    readonly value: TeamHubNetworkState;
    readonly basedOn: TeamHubNetworkState | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  const shown = override !== null && override.basedOn === state ? override.value : state;

  /** A person asked to look again: whatever the last action said is stale. */
  const recheck = useCallback(() => {
    setOverride(null);
    setRequestError(null);
    appAtomRegistry.refresh(query);
  }, [query]);

  // Coming back from the Tailscale app or admin console is the moment to look again.
  useEffect(() => {
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, [recheck]);

  // The first request through a new share makes Tailscale issue its certificate.
  const waiting = shown?.status === "exposed" && !shown.reachable;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => appAtomRegistry.refresh(query), 3_000);
    return () => clearInterval(timer);
  }, [waiting, query]);

  const run = useCallback(
    async (type: "exposeHub" | "unexposeHub", exposureOverride?: TeamHubExposure) => {
      setBusy(true);
      setRequestError(null);
      const outcome = await command({
        prepared,
        action: {
          type,
          input: { hubPort, servePort, exposure: exposureOverride ?? exposure },
        },
      });
      setBusy(false);
      if (!AsyncResult.isSuccess(outcome) || !isNetworkState(outcome.value)) {
        setRequestError(REQUEST_FAILED);
        return;
      }
      setOverride({ value: outcome.value, basedOn: state });
      if (outcome.value.status !== "failed") appAtomRegistry.refresh(query);
    },
    [command, prepared, hubPort, servePort, exposure, state, query],
  );

  return { shown, busy, requestError, recheck, run };
}

function CheckingTailscale() {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Spinner size="sm" tone="muted" />
      Checking Tailscale…
    </p>
  );
}

/**
 * Setup step: share a hub running on this computer over Tailscale. Reports the
 * address once it answers, or null while there is none to use.
 * `onAddress` must be a stable callback.
 */
export function HubSharing({
  prepared,
  exposure,
  onAddress,
}: {
  prepared: PreparedConnection;
  exposure: TeamHubExposure;
  onAddress: (address: string | null) => void;
}) {
  const [hubPort, setHubPort] = useState(DEFAULT_HUB_PORT);
  const [hubPortDraft, setHubPortDraft] = useState(String(DEFAULT_HUB_PORT));
  const [servePort, setServePort] = useState(DEFAULT_SHARE_PORT);
  const input = useMemo(() => ({ hubPort, servePort, exposure }), [hubPort, servePort, exposure]);
  const { shown, busy, requestError, recheck, run } = useHubNetwork(prepared, input);

  const address = shown?.status === "exposed" && shown.reachable ? shown.url : null;
  useEffect(() => {
    onAddress(address);
  }, [address, onAddress]);

  if (shown === null) return <CheckingTailscale />;

  const commitHubPort = () => {
    const next = Number.parseInt(hubPortDraft, 10);
    if (Number.isInteger(next) && next >= 1 && next <= 65535) {
      setHubPort(next);
    } else {
      setHubPortDraft(String(hubPort));
    }
  };

  return (
    <div className="space-y-2">
      <ReachNotice
        presentation={presentNetworkState(shown, { exposure, hubPort, servePort })}
        busy={busy}
        onRetry={recheck}
        onShare={() => void run("exposeHub")}
        onUsePort={setServePort}
      >
        {shown.status === "exposed" ? (
          <Input
            readOnly
            size="sm"
            font="mono"
            aria-label="Hub address"
            value={shown.url}
            onFocus={(event) => event.target.select()}
          />
        ) : null}
        {shown.status === "no-hub" ? (
          <label className="flex items-center gap-2 text-xs">
            Hub port
            <div className="w-24">
              <Input
                size="sm"
                type="number"
                font="mono"
                value={hubPortDraft}
                onChange={(event) => setHubPortDraft(event.target.value)}
                onBlur={commitHubPort}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitHubPort();
                }}
              />
            </div>
          </label>
        ) : null}
      </ReachNotice>
      {requestError ? (
        <p role="alert" className="text-sm text-destructive">
          {requestError}
        </p>
      ) : null}
    </div>
  );
}

function HubAddressStatus({ prepared, url }: { prepared: PreparedConnection; url: string }) {
  const servePort = servePortOfUrl(url);
  // Exposure only decides whether Funnel is required to share, never how an
  // existing share is read, so this read asks for the weaker, private one.
  const input = useMemo(
    () => ({ hubPort: DEFAULT_HUB_PORT, servePort, exposure: "private" as const }),
    [servePort],
  );
  const { shown, busy, requestError, run } = useHubNetwork(prepared, input);
  const [confirmingStop, setConfirmingStop] = useState(false);

  if (shown?.status === "exposed") {
    return (
      <div className="space-y-2">
        <h3 className="font-medium">Hub address</h3>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-xs text-muted-foreground">{shown.url}</span>
            <Badge variant={shown.exposure === "public" ? "warning" : "info"} size="sm">
              {shown.exposure === "public" ? "Public" : "Private"}
            </Badge>
            {shown.reachable ? null : (
              <Badge variant="outline" size="sm">
                Waiting for HTTPS
              </Badge>
            )}
          </div>
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => setConfirmingStop(true)}
          >
            Stop sharing
          </Button>
        </div>
        {requestError ? (
          <p role="alert" className="text-sm text-destructive">
            {requestError}
          </p>
        ) : null}
        <AlertDialog
          open={confirmingStop}
          onOpenChange={(open) => {
            if (!busy) setConfirmingStop(open);
          }}
        >
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>Stop sharing the hub?</AlertDialogTitle>
              <AlertDialogDescription>
                Teammates can't reach the hub until you share it again, and invite links stop
                working. Nothing is deleted.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose
                disabled={busy}
                render={<Button variant="outline" disabled={busy} />}
              >
                Cancel
              </AlertDialogClose>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  void run("unexposeHub").then(() => setConfirmingStop(false));
                }}
              >
                {busy ? (
                  <>
                    <Spinner size="sm" />
                    Stopping…
                  </>
                ) : (
                  "Stop sharing"
                )}
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      </div>
    );
  }

  // Sharing was stopped, or never started, and the hub is up on this computer:
  // offer the way back in.
  if (shown?.status === "ready") {
    return (
      <div className="space-y-2">
        <h3 className="font-medium">Hub address</h3>
        <p className="text-muted-foreground">
          <span className="font-mono text-xs">{url}</span> isn't shared right now.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="xs" disabled={busy} onClick={() => void run("exposeHub", "public")}>
            Share publicly
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => void run("exposeHub", "private")}
          >
            Share on my tailnet
          </Button>
        </div>
        {requestError ? (
          <p role="alert" className="text-sm text-destructive">
            {requestError}
          </p>
        ) : null}
      </div>
    );
  }

  return null;
}

/**
 * The admin's view of a hub they share over Tailscale from this computer. Shows
 * nothing for other addresses: only a `*.ts.net` name can be a Tailscale share,
 * so only those are worth asking Tailscale about.
 */
export function HubAddressRow({ prepared, url }: { prepared: PreparedConnection; url: string }) {
  return isTailscaleShareUrl(url) ? <HubAddressStatus prepared={prepared} url={url} /> : null;
}

function useReachabilityCheck(prepared: PreparedConnection) {
  const command = useAtomCommand(teamHubActionCommand, { reportFailure: false });
  return useCallback(
    async (url: string): Promise<TeamHubReachability | null> => {
      const outcome = await command({ prepared, action: { type: "checkHub", input: { url } } });
      return AsyncResult.isSuccess(outcome) && isReachability(outcome.value) ? outcome.value : null;
    },
    [command, prepared],
  );
}

/**
 * Advisory check of a pasted invite, run from this computer's own server (the
 * machine that will connect). It never blocks joining: a probe that fails
 * where joining would work must not lock anyone out.
 */
export function HubLinkCheck({ prepared, url }: { prepared: PreparedConnection; url: string }) {
  const check = useReachabilityCheck(prepared);
  const [result, setResult] = useState<{
    readonly url: string;
    readonly value: TeamHubReachability | null;
  } | null>(null);

  const runCheck = useCallback(async () => {
    setResult({ url, value: await check(url) });
  }, [check, url]);

  useEffect(() => {
    // Let typing and pasting settle before spending a request on a half-edited link.
    const timer = setTimeout(() => void runCheck(), 600);
    return () => clearTimeout(timer);
  }, [runCheck]);

  // An answer for an address the person has since edited is not an answer.
  const current = result !== null && result.url === url ? result : null;
  if (current === null) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner size="sm" tone="muted" />
        Checking the hub…
      </p>
    );
  }
  if (current.value === null) {
    return (
      <p role="alert" className="text-sm text-muted-foreground">
        Couldn't check the hub from this computer. You can still try joining.
      </p>
    );
  }
  return (
    <ReachNotice
      presentation={presentReachability(current.value)}
      onRetry={() => {
        setResult(null);
        void runCheck();
      }}
    />
  );
}

/** Explains a hub connection that is down, on demand rather than by polling. */
export function HubConnectionCheck({
  prepared,
  url,
}: {
  prepared: PreparedConnection;
  url: string;
}) {
  const check = useReachabilityCheck(prepared);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<TeamHubReachability | null | undefined>(undefined);

  const run = async () => {
    setPending(true);
    setResult(await check(url));
    setPending(false);
  };

  return (
    <div className="space-y-2">
      <Button size="xs" variant="outline" disabled={pending} onClick={() => void run()}>
        {pending ? (
          <>
            <Spinner size="sm" />
            Checking…
          </>
        ) : (
          "Check connection"
        )}
      </Button>
      {result === null ? (
        <p role="alert" className="text-sm text-destructive">
          {REQUEST_FAILED}
        </p>
      ) : result !== undefined ? (
        <ReachNotice presentation={presentReachability(result)} onRetry={() => void run()} />
      ) : null}
    </div>
  );
}
