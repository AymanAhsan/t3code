import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  runTailscaleForStdout,
  TailscaleStatusParseError,
  type TailscaleCommandError,
  type TailscaleExposure,
  TAILSCALE_STATUS_TIMEOUT,
} from "./tailscale.ts";

const TAILSCALE_SERVE_STATUS_TIMEOUT = Duration.seconds(3);

/**
 * Why this machine cannot share a port over Tailscale right now. Each reason
 * has exactly one fix a person can do, which is what the UI shows.
 */
export const TailscaleBlockedReason = Schema.Literals([
  "not-installed",
  "daemon-not-running",
  "signed-out",
  "stopped",
  "awaiting-approval",
  "https-disabled",
  "funnel-not-allowed",
]);
export type TailscaleBlockedReason = typeof TailscaleBlockedReason.Type;

type TailscaleBackendState = "running" | "needs-login" | "needs-machine-auth" | "stopped" | "other";

/**
 * What `tailscale status --json` says about this node, reduced to the facts
 * that decide whether sharing can work. `null` means the CLI did not report the
 * fact (older versions), which must never be read as "no".
 */
export interface TailscaleNodeFacts {
  readonly backendState: TailscaleBackendState;
  readonly magicDnsName: string | null;
  readonly magicDnsEnabled: boolean | null;
  readonly httpsEnabled: boolean | null;
  readonly funnelAllowed: boolean | null;
}

const TailscaleNodeFactsJson = Schema.Struct({
  BackendState: Schema.optional(Schema.Unknown),
  CertDomains: Schema.optional(Schema.Unknown),
  CurrentTailnet: Schema.optional(
    Schema.Struct({ MagicDNSEnabled: Schema.optional(Schema.Unknown) }),
  ),
  Self: Schema.optional(
    Schema.Struct({
      DNSName: Schema.optional(Schema.Unknown),
      CapMap: Schema.optional(Schema.Unknown),
      Capabilities: Schema.optional(Schema.Unknown),
    }),
  ),
});

const decodeNodeFactsJson = Schema.decodeEffect(Schema.fromJsonString(TailscaleNodeFactsJson));

const BACKEND_STATES: Readonly<Record<string, TailscaleBackendState | undefined>> = {
  Running: "running",
  NeedsLogin: "needs-login",
  NeedsMachineAuth: "needs-machine-auth",
  Stopped: "stopped",
};

/**
 * Capability names this node holds. The newer `CapMap` and the older
 * `Capabilities` list are both read, so either shape of CLI answers.
 */
function capabilityNames(self: {
  readonly CapMap?: unknown;
  readonly Capabilities?: unknown;
}): ReadonlySet<string> {
  const names = new Set<string>();
  if (typeof self.CapMap === "object" && self.CapMap !== null && !Array.isArray(self.CapMap)) {
    for (const name of Object.keys(self.CapMap)) names.add(name);
  }
  if (Array.isArray(self.Capabilities)) {
    for (const name of self.Capabilities) if (typeof name === "string") names.add(name);
  }
  return names;
}

export const parseTailscaleNodeFacts = (
  rawStatusJson: string,
): Effect.Effect<TailscaleNodeFacts, TailscaleStatusParseError> =>
  decodeNodeFactsJson(rawStatusJson).pipe(
    Effect.mapError((cause) => new TailscaleStatusParseError({ cause })),
    Effect.map((parsed) => {
      const self: {
        readonly DNSName?: unknown;
        readonly CapMap?: unknown;
        readonly Capabilities?: unknown;
      } = parsed.Self ?? {};
      const names = capabilityNames(self);
      const certDomains = Array.isArray(parsed.CertDomains) ? parsed.CertDomains : [];
      const capabilitiesKnown = names.size > 0;
      const certDomainsKnown = parsed.CertDomains !== undefined;
      const dnsName =
        typeof self.DNSName === "string" ? self.DNSName.trim().replace(/\.$/u, "") : "";
      const magicDnsEnabled = parsed.CurrentTailnet?.MagicDNSEnabled;
      return {
        backendState:
          (typeof parsed.BackendState === "string"
            ? BACKEND_STATES[parsed.BackendState]
            : undefined) ?? "other",
        magicDnsName: dnsName.length > 0 ? dnsName : null,
        magicDnsEnabled: typeof magicDnsEnabled === "boolean" ? magicDnsEnabled : null,
        httpsEnabled:
          names.has("https") || certDomains.length > 0
            ? true
            : capabilitiesKnown || certDomainsKnown
              ? false
              : null,
        funnelAllowed: capabilitiesKnown ? names.has("funnel") : null,
      };
    }),
  );

export const readTailscaleNodeFacts = runTailscaleForStdout({
  subcommand: "status",
  args: ["status", "--json"],
  timeout: TAILSCALE_STATUS_TIMEOUT,
}).pipe(Effect.flatMap(parseTailscaleNodeFacts));

/**
 * The one thing blocking sharing, or null when Tailscale is ready. Absent facts
 * (`null`) never block: a wrong "blocked" strands someone, while a missed one
 * only surfaces when the share command itself reports it.
 */
export function tailscaleBlockedReason(
  facts: TailscaleNodeFacts,
  input: { readonly exposure: TailscaleExposure },
): TailscaleBlockedReason | null {
  switch (facts.backendState) {
    case "needs-login":
      return "signed-out";
    case "needs-machine-auth":
      return "awaiting-approval";
    case "stopped":
    case "other":
      return "stopped";
    case "running":
      break;
  }
  if (
    facts.magicDnsName === null ||
    facts.magicDnsEnabled === false ||
    facts.httpsEnabled === false
  ) {
    return "https-disabled";
  }
  if (input.exposure === "funnel" && facts.funnelAllowed === false) {
    return "funnel-not-allowed";
  }
  return null;
}

/**
 * Maps a failed tailscale command to the blocked reason it implies, or null
 * when the failure says nothing about the machine's setup.
 */
export function tailscaleBlockedReasonOfFailure(
  error: TailscaleCommandError | TailscaleStatusParseError,
): TailscaleBlockedReason | null {
  switch (error._tag) {
    case "TailscaleCommandSpawnError":
      return "not-installed";
    case "TailscaleCommandTimeoutError":
      return "daemon-not-running";
    case "TailscaleCommandExitError":
      switch (error.stderrDiagnostic) {
        case "daemon-unreachable":
          return "daemon-not-running";
        case "not-logged-in":
          return "signed-out";
        case "https-disabled":
          return "https-disabled";
        case "funnel-not-allowed":
          return "funnel-not-allowed";
        default:
          return null;
      }
    default:
      return null;
  }
}

/** One web mapping from `tailscale serve status --json`. */
export interface TailscaleServeMapping {
  readonly host: string;
  readonly port: number;
  /** Where "/" is proxied to, e.g. `http://127.0.0.1:8080`; null for other handler kinds. */
  readonly proxy: string | null;
  /** True when the mapping is published to the public internet (Funnel). */
  readonly funnel: boolean;
}

export interface TailscaleServeConfig {
  readonly mappings: ReadonlyArray<TailscaleServeMapping>;
  /** Ports listening for something other than a web mapping (raw TCP forwards). */
  readonly otherPorts: ReadonlyArray<number>;
}

const TailscaleServeConfigJson = Schema.Struct({
  TCP: Schema.optional(Schema.Unknown),
  Web: Schema.optional(Schema.Unknown),
  AllowFunnel: Schema.optional(Schema.Unknown),
});

const decodeServeConfigJson = Schema.decodeEffect(Schema.fromJsonString(TailscaleServeConfigJson));

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};

const splitHostPort = (hostPort: string): { host: string; port: number } | null => {
  const separator = hostPort.lastIndexOf(":");
  if (separator <= 0) return null;
  const port = Number.parseInt(hostPort.slice(separator + 1), 10);
  return Number.isInteger(port) ? { host: hostPort.slice(0, separator), port } : null;
};

export const parseTailscaleServeConfig = (
  rawServeStatusJson: string,
): Effect.Effect<TailscaleServeConfig, TailscaleStatusParseError> =>
  // `serve status --json` prints nothing at all when no mapping exists.
  decodeServeConfigJson(rawServeStatusJson.trim().length === 0 ? "{}" : rawServeStatusJson).pipe(
    Effect.mapError((cause) => new TailscaleStatusParseError({ cause })),
    Effect.map((parsed) => {
      const funnelFlags = asRecord(parsed.AllowFunnel);
      const mappings: Array<TailscaleServeMapping> = [];
      for (const [hostPort, server] of Object.entries(asRecord(parsed.Web))) {
        const address = splitHostPort(hostPort);
        if (address === null) continue;
        const rootHandler = asRecord(asRecord(asRecord(server).Handlers)["/"]);
        mappings.push({
          ...address,
          proxy: typeof rootHandler.Proxy === "string" ? rootHandler.Proxy : null,
          funnel: funnelFlags[hostPort] === true,
        });
      }
      const webPorts = new Set(mappings.map((mapping) => mapping.port));
      const otherPorts = Object.keys(asRecord(parsed.TCP))
        .map((port) => Number.parseInt(port, 10))
        .filter((port) => Number.isInteger(port) && !webPorts.has(port));
      return { mappings, otherPorts };
    }),
  );

export const readTailscaleServeConfig = runTailscaleForStdout({
  subcommand: "serve",
  args: ["serve", "status", "--json"],
  timeout: TAILSCALE_SERVE_STATUS_TIMEOUT,
}).pipe(Effect.flatMap(parseTailscaleServeConfig));
