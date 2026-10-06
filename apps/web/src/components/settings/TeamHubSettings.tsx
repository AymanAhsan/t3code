import { useAtomValue } from "@effect/atom-react";
import {
  parseTeamHubLink,
  readTeamHubInvites,
  readTeamHubState,
  withTeamHubOrigin,
  type TeamHubAction,
} from "@t3tools/client-runtime/state/team-hub";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { TeamHubInvite } from "@t3tools/contracts/teamHub";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { cn } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { usePreparedConnection } from "~/state/session";
import { teamHubActionCommand } from "~/state/teamHub";
import { useAtomCommand } from "~/state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Radio, RadioGroup } from "../ui/radio-group";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { HubAddressRow, HubConnectionCheck, HubLinkCheck, HubSharing } from "./TeamHubReach";

type HubReach = "public" | "private" | "other";

const HUB_REACH_OPTIONS: ReadonlyArray<{
  readonly value: HubReach;
  readonly title: string;
  readonly description: string;
}> = [
  {
    value: "public",
    title: "Tailscale, public (Funnel)",
    description: "Teammates install nothing. Joining still needs an invite.",
  },
  {
    value: "private",
    title: "Tailscale, private",
    description: "Only people on your tailnet can reach it.",
  },
  {
    value: "other",
    title: "Another address",
    description: "A LAN address, your own domain, or a tunnel you already run.",
  },
];

function inviteLink(url: string, invite: TeamHubInvite): string {
  const link = new URL("/join", url);
  link.hash = `token=${encodeURIComponent(invite.token)}`;
  return link.toString();
}

// Invite links reuse the address this hub was set up with, so a loopback address only works
// on the admin's own machine.
function isLoopbackAddress(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return isLocalLoopbackHost(host) || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

/**
 * Bordered list inside a settings row, the same container the browser profiles use. Items are
 * direct children; the container draws the dividers.
 */
function HubList({ children }: { readonly children: ReactNode }) {
  return (
    <div className="mt-2 mb-2 overflow-hidden rounded-lg border border-border/60 [&>*+*]:border-t [&>*+*]:border-border/60">
      {children}
    </div>
  );
}

function HubListItem({
  children,
  action,
}: {
  readonly children: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">{children}</div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

function AdminInvites({
  prepared,
  url,
  invite,
  busy,
  onCreate,
  onRevoke,
}: {
  prepared: PreparedConnection;
  url: string;
  invite: TeamHubInvite | null;
  busy: boolean;
  onCreate: () => void;
  onRevoke: (inviteId: string) => void;
}) {
  const query = useMemo(
    () =>
      connectionAtomRuntime
        .atom(readTeamHubInvites(prepared))
        .pipe(
          Atom.swr({ staleTime: 4_000, revalidateOnMount: true }),
          Atom.withLabel("team-hub-invites"),
        ),
    [prepared],
  );
  const invites = Option.getOrNull(AsyncResult.value(useAtomValue(query))) ?? [];
  useEffect(() => {
    const timer = setInterval(() => appAtomRegistry.refresh(query), 5_000);
    return () => clearInterval(timer);
  }, [query]);
  const open = invites.filter((item) => !item.usedAt && !item.revokedAt);
  const loopback = isLoopbackAddress(url);
  return (
    <>
      <HubAddressRow prepared={prepared} url={url} />
      <SettingsRow
        title="Invites"
        description="Create a link a teammate opens to join this team."
        control={
          <Button size="sm" variant="outline" disabled={busy} onClick={onCreate}>
            Create invite
          </Button>
        }
      >
        {loopback || invite || open.length > 0 ? (
          <div className="space-y-2 pt-2 pb-1">
            {loopback && (
              <Alert variant="warning">
                <TriangleAlertIcon />
                <AlertDescription>
                  <p>
                    This hub's address is {new URL(url).host}, which only works on this computer.
                    Teammates can't use invites from it. Set the hub up again from a link with an
                    address they can reach.
                  </p>
                </AlertDescription>
              </Alert>
            )}
            {invite && (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">
                  New invite, expires {new Date(invite.expiresAt).toLocaleString()}.
                </p>
                <Input
                  size="sm"
                  font="mono"
                  aria-label="Invite link"
                  readOnly
                  value={inviteLink(url, invite)}
                  onFocus={(event) => event.target.select()}
                />
              </div>
            )}
          </div>
        ) : null}
        {open.length > 0 ? (
          <HubList>
            {open.map((item) => (
              <HubListItem
                key={item.id}
                action={
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => onRevoke(item.id)}
                  >
                    Revoke
                  </Button>
                }
              >
                <p className="text-sm">Expires {new Date(item.expiresAt).toLocaleString()}</p>
              </HubListItem>
            ))}
          </HubList>
        ) : null}
      </SettingsRow>
    </>
  );
}

function ConnectedTeamHub({ prepared }: { prepared: PreparedConnection }) {
  const query = useMemo(
    () =>
      connectionAtomRuntime
        .atom(readTeamHubState(prepared))
        .pipe(
          Atom.swr({ staleTime: 4_000, revalidateOnMount: true }),
          Atom.withLabel("team-hub-state"),
        ),
    [prepared],
  );
  const result = useAtomValue(query);
  const state = Option.getOrNull(AsyncResult.value(result));
  const [joinLink, setJoinLink] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [settingUp, setSettingUp] = useState(false);
  const [teamName, setTeamName] = useState("");
  const [repo, setRepo] = useState("");
  const [invite, setInvite] = useState<TeamHubInvite | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reach, setReach] = useState<HubReach>("public");
  // The address the shared hub answers on, once it does. Setup uses it in place of
  // whatever address the setup link printed.
  const [shareAddress, setShareAddress] = useState<string | null>(null);
  const parsedLink = useMemo(() => parseTeamHubLink(joinLink), [joinLink]);
  const sharing = settingUp && reach !== "other";
  const command = useAtomCommand(teamHubActionCommand, { reportFailure: false });

  useEffect(() => {
    const timer = setInterval(() => appAtomRegistry.refresh(query), 5_000);
    return () => clearInterval(timer);
  }, [query]);

  const act = async (action: TeamHubAction) => {
    setBusy(true);
    setError(null);
    const outcome = await command({ prepared, action });
    setBusy(false);
    if (AsyncResult.isSuccess(outcome)) {
      if (action.type === "invite") setInvite(outcome.value as TeamHubInvite);
      appAtomRegistry.refresh(query);
    } else {
      setError("The team hub request failed. Check the hub address, membership, and connection.");
    }
  };

  if (state === null) {
    return <SettingsRow title="Hub status" description="Loading…" />;
  }
  const snapshot = state.snapshot;
  const self = snapshot?.members.find((member) => member.id === snapshot.selfId);
  const pendingTasks =
    snapshot?.tasks.filter(
      (task) =>
        task.status === "suggested" &&
        (task.assigneeId === null || task.assigneeId === snapshot.selfId),
    ) ?? [];
  const memberName = (memberId: string) =>
    snapshot?.members.find((member) => member.id === memberId)?.name ?? "Teammate";

  const submit = () => {
    if (!parsedLink || !displayName.trim() || (settingUp && (!teamName.trim() || !repo.trim()))) {
      setError("Enter a valid hub link and all required fields.");
      return;
    }
    const target = sharing
      ? shareAddress === null
        ? null
        : withTeamHubOrigin(parsedLink, shareAddress)
      : parsedLink;
    if (target === null) {
      setError("Share the hub over Tailscale first, or choose another address.");
      return;
    }
    void act(
      settingUp
        ? {
            type: "bootstrap",
            input: {
              ...target,
              displayName: displayName.trim(),
              teamName: teamName.trim(),
              repo: repo.trim(),
            },
          }
        : { type: "join", input: { ...target, displayName: displayName.trim() } },
    );
  };

  const errorRow = error ? (
    <div role="alert" className="px-3 py-2.5 text-xs text-destructive sm:px-4">
      {error}
    </div>
  ) : null;

  if (state.url === null) {
    return (
      <>
        <SettingsRow
          title={settingUp ? "Set up a hub" : "Join a team"}
          description={
            settingUp
              ? "Create the first team with the setup link printed by your hub."
              : "Join a team with the invite link from its admin."
          }
          control={
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setSettingUp(!settingUp);
                setShareAddress(null);
                setError(null);
              }}
            >
              {settingUp ? "Join a team instead" : "Set up a hub"}
            </Button>
          }
        />
        {settingUp && (
          <SettingsRow
            title="How teammates reach the hub"
            description="Pick how the hub is shared. Sharing over Tailscale starts here."
          >
            <div className="space-y-3 pt-3 pb-2">
              <RadioGroup
                aria-label="How will teammates reach the hub?"
                value={reach}
                onValueChange={(value) => {
                  if (value === "public" || value === "private" || value === "other") {
                    setReach(value);
                    setShareAddress(null);
                  }
                }}
              >
                {HUB_REACH_OPTIONS.map((option) => (
                  <label key={option.value} className="flex cursor-pointer items-start gap-2">
                    <Radio value={option.value} className="mt-0.5" />
                    <span>
                      <span className="block text-sm font-medium">{option.title}</span>
                      <span className="block text-xs text-muted-foreground">
                        {option.description}
                      </span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
              {reach !== "other" && (
                <HubSharing
                  key={reach}
                  prepared={prepared}
                  exposure={reach}
                  onAddress={setShareAddress}
                />
              )}
            </div>
          </SettingsRow>
        )}
        <SettingsRow
          title={settingUp ? "Create team" : "Join team"}
          description={
            settingUp
              ? "Your name, the team, and the repository it works on."
              : "Paste the invite link and choose the name teammates will see."
          }
          control={
            <Button
              type="submit"
              form="team-hub-form"
              size="sm"
              disabled={busy || (sharing && shareAddress === null)}
            >
              {settingUp ? "Create team" : "Join team"}
            </Button>
          }
        >
          <form
            id="team-hub-form"
            className="space-y-2 pt-3 pb-2"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <Input
              size="sm"
              aria-label={settingUp ? "Hub setup link" : "Team invite link"}
              placeholder={
                settingUp
                  ? "https://hub.example.com/setup#token=…"
                  : "https://hub.example.com/join#token=…"
              }
              value={joinLink}
              onChange={(event) => setJoinLink(event.target.value)}
            />
            {sharing && shareAddress !== null && parsedLink !== null && (
              <p className="text-xs text-muted-foreground">
                Teammates will use {shareAddress}, not {parsedLink.url}.
              </p>
            )}
            {!settingUp && parsedLink !== null && (
              <HubLinkCheck prepared={prepared} url={parsedLink.url} />
            )}
            <Input
              size="sm"
              aria-label="Your display name"
              placeholder="Your display name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
            {settingUp && (
              <>
                <Input
                  size="sm"
                  aria-label="Team name"
                  placeholder="Team name"
                  value={teamName}
                  onChange={(event) => setTeamName(event.target.value)}
                />
                <Input
                  size="sm"
                  aria-label="Git repository"
                  placeholder="Git remote URL"
                  value={repo}
                  onChange={(event) => setRepo(event.target.value)}
                />
              </>
            )}
          </form>
        </SettingsRow>
        {errorRow}
      </>
    );
  }

  return (
    <>
      <SettingsRow
        title={snapshot?.team.name ?? state.url}
        description={snapshot ? <span className="font-mono">{snapshot.team.repo}</span> : undefined}
        status={
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge size="sm" variant={state.status === "connected" ? "success" : "warning"}>
                {state.status.charAt(0).toUpperCase() + state.status.slice(1)}
              </Badge>
              {state.error ? <span>{state.error}</span> : null}
            </div>
            {state.status !== "connected" && (
              <HubConnectionCheck prepared={prepared} url={state.url} />
            )}
          </div>
        }
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void act({ type: "leave" })}
          >
            Leave team
          </Button>
        }
      />
      {snapshot && (
        <>
          <SettingsRow title="Members">
            <HubList>
              {snapshot.members.map((member) => (
                <HubListItem
                  key={member.id}
                  action={
                    self?.role === "admin" && member.id !== snapshot.selfId ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void act({ type: "removeMember", memberId: member.id })}
                      >
                        Remove
                      </Button>
                    ) : null
                  }
                >
                  <p className="flex items-center gap-2 text-sm">
                    <span
                      aria-hidden
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        member.online ? "bg-success" : "bg-muted-foreground/40",
                      )}
                    />
                    <span className="sr-only">{member.online ? "Online" : "Offline"}</span>
                    <span className="truncate">{member.name}</span>
                    {member.id === snapshot.selfId ? (
                      <span className="text-xs text-muted-foreground">You</span>
                    ) : null}
                  </p>
                </HubListItem>
              ))}
            </HubList>
          </SettingsRow>
          {self?.role === "admin" && (
            <AdminInvites
              prepared={prepared}
              url={state.url}
              invite={invite}
              busy={busy}
              onCreate={() => void act({ type: "invite" })}
              onRevoke={(inviteId) => void act({ type: "revokeInvite", inviteId })}
            />
          )}
          <SettingsRow
            title="Suggested tasks"
            description={pendingTasks.length === 0 ? "No incoming tasks." : undefined}
          >
            {pendingTasks.length > 0 ? (
              <HubList>
                {pendingTasks.map((task) => (
                  <HubListItem
                    key={task.id}
                    action={
                      <>
                        <Button
                          size="xs"
                          disabled={busy}
                          onClick={() =>
                            void act({
                              type: "decideTask",
                              taskId: task.id,
                              decision: "accepted",
                            })
                          }
                        >
                          Accept
                        </Button>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            void act({
                              type: "decideTask",
                              taskId: task.id,
                              decision: "dismissed",
                            })
                          }
                        >
                          Dismiss
                        </Button>
                      </>
                    }
                  >
                    <p className="text-sm">{task.text}</p>
                  </HubListItem>
                ))}
              </HubList>
            ) : null}
          </SettingsRow>
          <SettingsRow
            title="Recent activity"
            description={snapshot.summaries.length === 0 ? "No activity yet." : undefined}
          >
            {snapshot.summaries.length > 0 ? (
              <HubList>
                {snapshot.summaries.slice(0, 10).map((summary) => (
                  <HubListItem key={summary.id}>
                    <p className="text-sm">{summary.description}</p>
                    <p className="text-xs text-muted-foreground">
                      {memberName(summary.memberId)} · {summary.branch} · {summary.files.length}{" "}
                      {summary.files.length === 1 ? "file" : "files"}
                    </p>
                  </HubListItem>
                ))}
              </HubList>
            ) : null}
          </SettingsRow>
          {snapshot.claims.length > 0 && (
            <SettingsRow title="File claims">
              <HubList>
                {snapshot.claims.map((claim) => (
                  <HubListItem key={claim.path}>
                    <p className="truncate font-mono text-xs">{claim.path}</p>
                    <p className="text-xs text-muted-foreground">{memberName(claim.memberId)}</p>
                  </HubListItem>
                ))}
              </HubList>
            </SettingsRow>
          )}
          {snapshot.notes.length > 0 && (
            <SettingsRow title="Notes">
              <HubList>
                {snapshot.notes.slice(0, 10).map((note) => (
                  <HubListItem key={note.id}>
                    <p className="text-sm">{note.text}</p>
                  </HubListItem>
                ))}
              </HubList>
            </SettingsRow>
          )}
          {snapshot.contractChanges.length > 0 && (
            <SettingsRow title="Interface changes">
              <HubList>
                {snapshot.contractChanges.slice(0, 10).map((change) => (
                  <HubListItem key={change.id}>
                    <p className="text-sm">{change.description}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {change.paths.join(", ")}
                    </p>
                  </HubListItem>
                ))}
              </HubList>
            </SettingsRow>
          )}
        </>
      )}
      {errorRow}
    </>
  );
}

export function TeamHubSettings() {
  const environmentId = usePrimaryEnvironmentId();
  const prepared = usePreparedConnection(environmentId);
  return (
    <SettingsSection id="team-hub" title="Team hub">
      {Option.isSome(prepared) ? (
        <ConnectedTeamHub prepared={prepared.value} />
      ) : (
        <SettingsRow
          title="No environment"
          description="Connect an environment to use a team hub."
        />
      )}
    </SettingsSection>
  );
}
