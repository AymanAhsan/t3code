import type {
  TeamHubExposure,
  TeamHubNetworkBlockedReason,
  TeamHubNetworkInput,
  TeamHubNetworkState,
  TeamHubReachability,
} from "@t3tools/contracts/teamHub";
import {
  buildTailscaleHttpsBaseUrl,
  disableTailscaleServe,
  ensureTailscaleServe,
  isTailscaleIpv4Address,
  readTailscaleNodeFacts,
  readTailscaleServeConfig,
  tailscaleBlockedReason,
  tailscaleBlockedReasonOfFailure,
  type TailscaleCommandError,
  type TailscaleExposure,
  type TailscaleServeConfig,
  type TailscaleStatusParseError,
} from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

const HEALTH_PROBE_TIMEOUT = Duration.millis(2_500);
// The first request through a new mapping makes Tailscale issue the HTTPS
// certificate, which can take several seconds.
const REACHABLE_ATTEMPTS = 10;
const REACHABLE_RETRY_DELAY = Duration.seconds(1);

export class TeamHubNetworkInvalidUrlError extends Schema.TaggedError<TeamHubNetworkInvalidUrlError>()(
  "TeamHubNetworkInvalidUrlError",
  {},
) {
  override get message(): string {
    return "The team hub address must be an http or https URL.";
  }
}

const HubHealth = Schema.Struct({ ok: Schema.Literal(true), protocolVersion: Schema.Number });

/**
 * Three outcomes, because they drive different decisions: a hub (ours to share
 * or join), nothing answering (safe to configure), or something else answering
 * (never overwrite its mapping).
 */
type HubProbe = "hub" | "other" | "unreachable";

type FailedReason = Extract<TeamHubNetworkState, { status: "failed" }>["reason"];

const toTailscaleExposure = (exposure: TeamHubExposure): TailscaleExposure =>
  exposure === "public" ? "funnel" : "serve";

/** The local port a mapping proxies to, or null when it proxies anywhere but loopback. */
const loopbackProxyPort = (proxy: string | null): number | null => {
  if (proxy === null) return null;
  try {
    const target = new URL(proxy);
    const loopback =
      target.hostname === "localhost" ||
      target.hostname === "127.0.0.1" ||
      target.hostname === "[::1]";
    const port = target.port.length > 0 ? Number.parseInt(target.port, 10) : null;
    return loopback ? port : null;
  } catch {
    return null;
  }
};

const isTailnetHost = (hostname: string): boolean =>
  hostname.toLowerCase().endsWith(".ts.net") || isTailscaleIpv4Address(hostname);

export class TeamHubNetwork extends Context.Service<
  TeamHubNetwork,
  {
    /** Where a hub on this machine stands on Tailscale. Derived fresh on every call. */
    readonly state: (input: TeamHubNetworkInput) => Effect.Effect<TeamHubNetworkState>;
    /** Shares the hub over Tailscale and waits for its HTTPS address to answer. Idempotent. */
    readonly expose: (input: TeamHubNetworkInput) => Effect.Effect<TeamHubNetworkState>;
    /** Stops sharing a mapping that fronts a hub; never touches anyone else's. */
    readonly unexpose: (input: TeamHubNetworkInput) => Effect.Effect<TeamHubNetworkState>;
    /** Whether this machine can reach a hub address, and when Tailscale is why not. */
    readonly check: (
      url: string,
    ) => Effect.Effect<TeamHubReachability, TeamHubNetworkInvalidUrlError>;
  }
>()("t3/teamHub/TeamHubNetwork") {}

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // The tailscale helpers need the spawner in their environment; this service
  // takes it once so its own methods carry no requirements.
  const withTailscale = <A, E>(
    effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
  ): Effect.Effect<A, E> =>
    effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

  const probeHub = (baseUrl: string): Effect.Effect<HubProbe> =>
    Effect.gen(function* () {
      const response = yield* client
        .execute(HttpClientRequest.get(new URL("/health", baseUrl).toString()))
        .pipe(
          Effect.timeout(HEALTH_PROBE_TIMEOUT),
          // Transport failure or timeout: nothing (reachable) is listening there.
          Effect.mapError(() => "unreachable" as const),
        );
      // A bad-gateway family answer means a proxy (Tailscale) answered for a
      // backend that is gone: a stale mapping, not a live occupant.
      if (response.status === 502 || response.status === 503 || response.status === 504) {
        return yield* Effect.fail("unreachable" as const);
      }
      yield* HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(HubHealth)),
        Effect.mapError(() => "other" as const),
      );
      return "hub" as const;
    }).pipe(Effect.catch((outcome) => Effect.succeed(outcome)));

  type Readiness =
    | { readonly _tag: "blocked"; readonly reason: TeamHubNetworkBlockedReason }
    | { readonly _tag: "ready"; readonly magicDnsName: string };

  const readiness = (exposure: TeamHubExposure): Effect.Effect<Readiness> =>
    withTailscale(readTailscaleNodeFacts).pipe(
      Effect.map((facts): Readiness => {
        const reason = tailscaleBlockedReason(facts, { exposure: toTailscaleExposure(exposure) });
        return reason !== null || facts.magicDnsName === null
          ? { _tag: "blocked", reason: reason ?? "https-disabled" }
          : { _tag: "ready", magicDnsName: facts.magicDnsName };
      }),
      // An unclassified failure still means Tailscale is not answering.
      Effect.catch((error: TailscaleCommandError | TailscaleStatusParseError) =>
        Effect.succeed<Readiness>({
          _tag: "blocked",
          reason: tailscaleBlockedReasonOfFailure(error) ?? "daemon-not-running",
        }),
      ),
    );

  const failedStateOf = (
    error: TailscaleCommandError | TailscaleStatusParseError,
  ): TeamHubNetworkState => {
    // A timeout here is a command that never finished, usually Tailscale waiting
    // for someone to approve a setting in its admin console; that is not "the
    // daemon is down", so it is checked before the generic mapping.
    if (error._tag === "TailscaleCommandTimeoutError") {
      return { status: "failed", reason: "timed-out" };
    }
    const blocked = tailscaleBlockedReasonOfFailure(error);
    if (blocked !== null) return { status: "blocked", reason: blocked };
    const reason: FailedReason =
      error._tag === "TailscaleCommandExitError" && error.stderrDiagnostic === "permission-denied"
        ? "permission-denied"
        : "command-failed";
    return { status: "failed", reason };
  };

  const stateWith = (
    input: TeamHubNetworkInput,
    ready: Extract<Readiness, { _tag: "ready" }>,
    config: TailscaleServeConfig,
  ): Effect.Effect<TeamHubNetworkState> =>
    Effect.gen(function* () {
      const host = ready.magicDnsName.toLowerCase();
      const mapping = config.mappings.find(
        (candidate) => candidate.host.toLowerCase() === host && candidate.port === input.servePort,
      );
      if (mapping === undefined) {
        if (config.otherPorts.includes(input.servePort)) {
          return { status: "conflict", servePort: input.servePort } as const;
        }
        const local = yield* probeHub(`http://127.0.0.1:${String(input.hubPort)}`);
        return local === "hub"
          ? ({ status: "ready", hubPort: input.hubPort } as const)
          : ({ status: "no-hub", hubPort: input.hubPort } as const);
      }
      const url = buildTailscaleHttpsBaseUrl({
        magicDnsName: ready.magicDnsName,
        servePort: input.servePort,
      });
      const exposed = (reachable: boolean) =>
        ({
          status: "exposed",
          servePort: input.servePort,
          exposure: mapping.funnel ? "public" : "private",
          url,
          reachable,
        }) as const;
      if ((yield* probeHub(url)) === "hub") return exposed(true);
      // Not answering yet. It is still ours when it proxies to the hub port the
      // admin named; anything else on this port belongs to someone else.
      return loopbackProxyPort(mapping.proxy) === input.hubPort
        ? exposed(false)
        : ({ status: "conflict", servePort: input.servePort } as const);
    });

  const state = (input: TeamHubNetworkInput): Effect.Effect<TeamHubNetworkState> =>
    Effect.gen(function* () {
      const ready = yield* readiness(input.exposure);
      if (ready._tag === "blocked") {
        return { status: "blocked", reason: ready.reason } as const;
      }
      const config = yield* withTailscale(readTailscaleServeConfig).pipe(
        Effect.map((value): TailscaleServeConfig | TeamHubNetworkState => value),
        Effect.catch((error) => Effect.succeed(failedStateOf(error))),
      );
      // A config we could not read is reported, never guessed at: expose would
      // otherwise overwrite a mapping it could not see.
      if ("status" in config) return config;
      return yield* stateWith(input, ready, config);
    });

  const awaitReachable = (url: string) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < REACHABLE_ATTEMPTS; attempt += 1) {
        if ((yield* probeHub(url)) === "hub") return;
        yield* Effect.sleep(REACHABLE_RETRY_DELAY);
      }
    });

  const unexpose = (input: TeamHubNetworkInput): Effect.Effect<TeamHubNetworkState> =>
    Effect.gen(function* () {
      const current = yield* state(input);
      // Only a mapping that fronts a hub is ours to remove.
      if (current.status !== "exposed") return current;
      const off = (exposure: TailscaleExposure) =>
        withTailscale(disableTailscaleServe({ servePort: input.servePort, exposure })).pipe(
          // Already gone is the state we want.
          Effect.catchTag("TailscaleCommandExitError", (error) =>
            error.stderrDiagnostic === "no-existing-handler" ? Effect.void : Effect.fail(error),
          ),
        );
      const result = yield* (
        current.exposure === "public"
          ? off("funnel").pipe(Effect.andThen(off("serve")))
          : off("serve")
      ).pipe(
        Effect.as(null),
        Effect.catch((error: TailscaleCommandError) => Effect.succeed(failedStateOf(error))),
      );
      return result ?? (yield* state(input));
    });

  const expose = (input: TeamHubNetworkInput): Effect.Effect<TeamHubNetworkState> =>
    Effect.gen(function* () {
      let current = yield* state(input);
      if (current.status === "exposed" && current.exposure !== input.exposure) {
        // A port is Serve or Funnel, never both: switching is off, then on.
        current = yield* unexpose(input);
      }
      if (current.status === "exposed") {
        if (!current.reachable) yield* awaitReachable(current.url);
        return yield* state(input);
      }
      // Anything but a free port with a hub behind it is reported as is.
      if (current.status !== "ready") return current;

      const failure = yield* withTailscale(
        ensureTailscaleServe({
          localPort: input.hubPort,
          servePort: input.servePort,
          localHost: "127.0.0.1",
          exposure: toTailscaleExposure(input.exposure),
        }),
      ).pipe(
        Effect.as(null),
        Effect.catch((error: TailscaleCommandError) => Effect.succeed(failedStateOf(error))),
      );
      if (failure !== null) return failure;

      const after = yield* state(input);
      if (after.status === "exposed" && !after.reachable) {
        yield* awaitReachable(after.url);
        return yield* state(input);
      }
      return after;
    });

  const check = (url: string): Effect.Effect<TeamHubReachability, TeamHubNetworkInvalidUrlError> =>
    Effect.gen(function* () {
      const target = yield* Effect.try({
        try: () => {
          const parsed = new URL(url);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new Error("Invalid scheme");
          }
          return parsed;
        },
        catch: () => new TeamHubNetworkInvalidUrlError(),
      });
      const tailnetHost = isTailnetHost(target.hostname);
      if ((yield* probeHub(target.origin)) === "hub") {
        return { reachable: true, tailnetHost, blocked: null };
      }
      // Tailscale is only worth explaining when the address is a tailnet one.
      if (!tailnetHost) return { reachable: false, tailnetHost, blocked: null };
      const ready = yield* readiness("private");
      return {
        reachable: false,
        tailnetHost,
        // Joining only needs Tailscale connected. HTTPS certificates and Funnel
        // are the sharer's concern, so they are never a reason for a member.
        blocked:
          ready._tag === "blocked" &&
          ready.reason !== "https-disabled" &&
          ready.reason !== "funnel-not-allowed"
            ? ready.reason
            : null,
      };
    });

  return TeamHubNetwork.of({ state, expose, unexpose, check });
});

export const layer = Layer.effect(TeamHubNetwork, make);
