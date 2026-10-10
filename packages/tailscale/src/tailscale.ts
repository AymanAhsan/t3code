import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export const DEFAULT_TAILSCALE_SERVE_PORT = 443;
export const TAILSCALE_STATUS_TIMEOUT = Duration.millis(1_500);
const TAILSCALE_SERVE_TIMEOUT = Duration.seconds(10);
const TAILSCALE_PROBE_TIMEOUT = Duration.millis(2_500);

// tailscale is a real executable everywhere (`tailscale.exe` on Windows), so
// it is always spawned directly rather than through cmd.exe shell mode.
const tailscaleCommandForPlatform = (platform: NodeJS.Platform): "tailscale" | "tailscale.exe" =>
  platform === "win32" ? "tailscale.exe" : "tailscale";

/**
 * Where Tailscale installs its CLI when it is not on `PATH`. A process keeps
 * the `PATH` it started with, so one launched before Tailscale was installed
 * cannot find it by name; on macOS the app does not put the CLI on `PATH` at
 * all. Tried only after the plain name fails to spawn.
 */
export function tailscaleFallbackExecutables(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ReadonlyArray<string> {
  switch (platform) {
    case "win32": {
      const roots = [
        env["ProgramFiles"],
        env["ProgramW6432"],
        env["ProgramFiles(x86)"],
        "C:\\Program Files",
      ];
      return [
        ...new Set(
          roots.flatMap((root) =>
            root !== undefined && root.length > 0 ? [`${root}\\Tailscale\\tailscale.exe`] : [],
          ),
        ),
      ];
    }
    case "darwin":
      return [
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/opt/homebrew/bin/tailscale",
        "/usr/local/bin/tailscale",
      ];
    default:
      return ["/usr/bin/tailscale", "/usr/sbin/tailscale", "/usr/local/bin/tailscale"];
  }
}

const TailscaleCommandContext = {
  executable: Schema.Literals(["tailscale", "tailscale.exe"]),
  subcommand: Schema.Literals(["status", "serve", "funnel"]),
  argumentCount: Schema.Number,
};

/**
 * Failure kinds we can name without quoting the CLI. Anything unrecognized
 * becomes "unknown" rather than falling back to raw text — stderr can contain
 * auth keys (`tskey-…`) and node names, and these labels are logged.
 */
export const TailscaleStderrDiagnostic = Schema.Literals([
  "no-existing-handler",
  "not-logged-in",
  "permission-denied",
  "daemon-unreachable",
  "https-disabled",
  "funnel-not-allowed",
  "unknown",
]);
export type TailscaleStderrDiagnostic = typeof TailscaleStderrDiagnostic.Type;

// Matched against stderr, most specific first. Patterns are deliberately short
// and anchored on tailscale's own wording. `permission-denied` precedes
// `daemon-unreachable` because a socket the user may not open reads as both.
const STDERR_DIAGNOSTIC_PATTERNS: ReadonlyArray<
  readonly [RegExp, Exclude<TailscaleStderrDiagnostic, "unknown">]
> = [
  [/handler does not exist/i, "no-existing-handler"],
  [/not logged in|logged out|needs? login/i, "not-logged-in"],
  [/permission denied|access denied|must be root|operation not permitted/i, "permission-denied"],
  [
    /failed to connect to local tailscale|doesn'?t appear to be running|is tailscaled? running/i,
    "daemon-unreachable",
  ],
  [/https must be enabled|not enabled on your tailnet/i, "https-disabled"],
  [/node attribute not set/i, "funnel-not-allowed"],
];

/** Classifies stderr into a safe label, dropping the text itself. */
const stderrDiagnosticOf = (stderr: string): TailscaleStderrDiagnostic | undefined => {
  if (stderr.trim().length === 0) {
    return undefined;
  }
  return STDERR_DIAGNOSTIC_PATTERNS.find(([pattern]) => pattern.test(stderr))?.[1] ?? "unknown";
};

export class TailscaleCommandSpawnError extends Schema.TaggedError<TailscaleCommandSpawnError>()(
  "TailscaleCommandSpawnError",
  {
    ...TailscaleCommandContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to spawn tailscale ${this.subcommand}.`;
  }
}

class TailscaleCommandOutputError extends Schema.TaggedError<TailscaleCommandOutputError>()(
  "TailscaleCommandOutputError",
  {
    ...TailscaleCommandContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read output from tailscale ${this.subcommand}.`;
  }
}

export class TailscaleCommandExitError extends Schema.TaggedError<TailscaleCommandExitError>()(
  "TailscaleCommandExitError",
  {
    ...TailscaleCommandContext,
    exitCode: Schema.Number,
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.Number,
    // A classified diagnostic, never raw CLI output. `tailscale` prints auth
    // keys and node identifiers into stderr, and this field is surfaced in
    // dev-runner logs — so it carries only a known-safe label from the closed
    // set below. Callers that need to recognize a specific failure (e.g.
    // `serve off` on a port with no mapping) match on the label.
    stderrDiagnostic: Schema.optional(TailscaleStderrDiagnostic),
  },
) {
  override get message(): string {
    return `tailscale ${this.subcommand} exited with code ${this.exitCode}.`;
  }
}

export class TailscaleCommandTimeoutError extends Schema.TaggedError<TailscaleCommandTimeoutError>()(
  "TailscaleCommandTimeoutError",
  {
    ...TailscaleCommandContext,
    timeoutMs: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `tailscale ${this.subcommand} timed out after ${this.timeoutMs}ms.`;
  }
}

export type TailscaleCommandError =
  | TailscaleCommandSpawnError
  | TailscaleCommandOutputError
  | TailscaleCommandExitError
  | TailscaleCommandTimeoutError;

export class TailscaleStatusParseError extends Schema.TaggedError<TailscaleStatusParseError>()(
  "TailscaleStatusParseError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to decode tailscale status JSON.";
  }
}

const TailscaleStatusSelf = Schema.Struct({
  DNSName: Schema.optional(Schema.Unknown),
  TailscaleIPs: Schema.optional(Schema.Unknown),
});

const TailscaleStatusJson = Schema.Struct({
  Self: Schema.optional(TailscaleStatusSelf),
});

export type TailscaleStatusJson = typeof TailscaleStatusJson.Type;

export interface TailscaleStatus {
  readonly magicDnsName: string | null;
  readonly tailnetIpv4Addresses: readonly string[];
}

const collectStdout = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const collectStderr = collectStdout;

const decodeTailscaleStatusJson = Schema.decodeEffect(Schema.fromJsonString(TailscaleStatusJson));

function normalizeMagicDnsName(status: TailscaleStatusJson): string | null {
  const dnsName = status.Self?.DNSName;
  if (typeof dnsName !== "string") {
    return null;
  }

  const normalized = dnsName.trim().replace(/\.$/u, "");
  return normalized.length > 0 ? normalized : null;
}

export const parseTailscaleMagicDnsName = (
  rawStatusJson: string,
): Effect.Effect<string | null, TailscaleStatusParseError> =>
  decodeTailscaleStatusJson(rawStatusJson).pipe(
    Effect.mapError((cause) => new TailscaleStatusParseError({ cause })),
    Effect.map(normalizeMagicDnsName),
  );

export function isTailscaleIpv4Address(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const [first, second, third, fourth] = parts.map((part) => Number.parseInt(part, 10));
  if (
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined ||
    [first, second, third, fourth].some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return first === 100 && second >= 64 && second <= 127;
}

export const parseTailscaleStatus = (
  rawStatusJson: string,
): Effect.Effect<TailscaleStatus, TailscaleStatusParseError> =>
  decodeTailscaleStatusJson(rawStatusJson).pipe(
    Effect.mapError((cause) => new TailscaleStatusParseError({ cause })),
    Effect.map((parsed) => {
      const rawIps = parsed.Self?.TailscaleIPs;
      const tailnetIpv4Addresses: Array<string> = [];
      if (Array.isArray(rawIps)) {
        for (const address of rawIps) {
          if (typeof address === "string" && isTailscaleIpv4Address(address)) {
            tailnetIpv4Addresses.push(address);
          }
        }
      }

      return {
        magicDnsName: normalizeMagicDnsName(parsed),
        tailnetIpv4Addresses,
      };
    }),
  );

/**
 * Starts the tailscale CLI by name, then from its standard install locations
 * when the name does not resolve. Only a failure to start moves on to the next
 * candidate; a CLI that started and failed is the answer. When nothing starts,
 * the error is the one for the plain name, since that is what a person expects
 * to have worked.
 */
const spawnTailscale = (
  args: ReadonlyArray<string>,
  commandContext: {
    readonly executable: "tailscale" | "tailscale.exe";
    readonly subcommand: "status" | "serve" | "funnel";
    readonly argumentCount: number;
  },
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const hostPlatform = yield* HostProcessPlatform;
    const hostEnvironment = yield* HostProcessEnvironment;
    const spawnCommand = (command: string) =>
      spawner.spawn(ChildProcess.make(command, args)).pipe(
        Effect.mapError((cause) => new TailscaleCommandSpawnError({ ...commandContext, cause })),
        // Spawning can also fail as a defect rather than a typed error - a
        // non-directory entry on PATH makes node throw ENOTDIR synchronously.
        // `mapError` never sees that, so it would escape as an uncaught error.
        Effect.catchDefect((cause) =>
          Effect.fail(new TailscaleCommandSpawnError({ ...commandContext, cause })),
        ),
      );

    const byName = yield* Effect.result(spawnCommand(commandContext.executable));
    if (Result.isSuccess(byName)) return byName.success;
    for (const path of tailscaleFallbackExecutables(hostPlatform, hostEnvironment)) {
      const atPath = yield* Effect.result(spawnCommand(path));
      if (Result.isSuccess(atPath)) return atPath.success;
    }
    return yield* byName.failure;
  });

/**
 * Runs a tailscale command that prints something we read (the `--json`
 * subcommands) and returns its stdout. Failures keep the structured shape the
 * other commands use: stderr is classified, never quoted.
 */
export const runTailscaleForStdout = (input: {
  readonly subcommand: "status" | "serve" | "funnel";
  readonly args: ReadonlyArray<string>;
  readonly timeout: Duration.Duration;
}) =>
  Effect.gen(function* () {
    const hostPlatform = yield* HostProcessPlatform;
    const commandContext = {
      executable: tailscaleCommandForPlatform(hostPlatform),
      subcommand: input.subcommand,
      argumentCount: input.args.length,
    };
    return yield* Effect.gen(function* () {
      const child = yield* spawnTailscale(input.args, commandContext);
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectStdout(child.stdout),
          collectStderr(child.stderr),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError((cause) => new TailscaleCommandOutputError({ ...commandContext, cause })),
      );
      if (exitCode !== 0) {
        return yield* new TailscaleCommandExitError({
          ...commandContext,
          exitCode,
          stdoutLength: stdout.length,
          stderrLength: stderr.length,
          ...(stderrDiagnosticOf(stderr) !== undefined
            ? { stderrDiagnostic: stderrDiagnosticOf(stderr) }
            : {}),
        });
      }
      return stdout;
    }).pipe(
      Effect.scoped,
      Effect.timeout(input.timeout),
      Effect.catchTags({
        TimeoutError: (cause) =>
          Effect.fail(
            new TailscaleCommandTimeoutError({
              ...commandContext,
              timeoutMs: Duration.toMillis(input.timeout),
              cause,
            }),
          ),
      }),
    );
  });

export const readTailscaleStatus = runTailscaleForStdout({
  subcommand: "status",
  args: ["status", "--json"],
  timeout: TAILSCALE_STATUS_TIMEOUT,
}).pipe(Effect.flatMap(parseTailscaleStatus));

export function buildTailscaleHttpsBaseUrl(input: {
  readonly magicDnsName: string;
  readonly servePort?: number;
}): string {
  const url = new URL(`https://${input.magicDnsName}`);
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  if (servePort !== DEFAULT_TAILSCALE_SERVE_PORT) {
    url.port = String(servePort);
  }
  url.pathname = "/";
  return url.toString();
}

/**
 * `serve` keeps a mapping private to the tailnet; `funnel` publishes the same
 * kind of mapping to the public internet. They share one config and a port is
 * one or the other, so callers switch by turning one off before the other on.
 */
export type TailscaleExposure = "serve" | "funnel";

const runTailscaleCommand = (
  subcommand: TailscaleExposure,
  args: readonly string[],
  timeoutInput: Duration.Input,
): Effect.Effect<void, TailscaleCommandError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const hostPlatform = yield* HostProcessPlatform;
    const commandContext = {
      executable: tailscaleCommandForPlatform(hostPlatform),
      subcommand,
      argumentCount: args.length,
    };
    const timeout = Duration.fromInputUnsafe(timeoutInput);
    return yield* Effect.gen(function* () {
      const child = yield* spawnTailscale(args, commandContext);
      const [stderr, exitCode] = yield* Effect.all(
        [collectStderr(child.stderr), child.exitCode.pipe(Effect.map(Number))],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError((cause) => new TailscaleCommandOutputError({ ...commandContext, cause })),
      );
      if (exitCode !== 0) {
        return yield* new TailscaleCommandExitError({
          ...commandContext,
          exitCode,
          stderrLength: stderr.length,
          ...(stderrDiagnosticOf(stderr) !== undefined
            ? { stderrDiagnostic: stderrDiagnosticOf(stderr) }
            : {}),
        });
      }
    }).pipe(
      Effect.scoped,
      Effect.timeout(timeout),
      Effect.catchTags({
        TimeoutError: (cause) =>
          Effect.fail(
            new TailscaleCommandTimeoutError({
              ...commandContext,
              timeoutMs: Duration.toMillis(timeout),
              cause,
            }),
          ),
      }),
    );
  });

export const ensureTailscaleServe = (input: {
  readonly localPort: number;
  readonly servePort?: number;
  readonly localHost?: string;
  readonly exposure?: TailscaleExposure;
}): Effect.Effect<void, TailscaleCommandError, ChildProcessSpawner.ChildProcessSpawner> => {
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  const localHost = input.localHost ?? "127.0.0.1";
  const exposure = input.exposure ?? "serve";
  const args = [exposure, "--bg", `--https=${servePort}`, `http://${localHost}:${input.localPort}`];
  return runTailscaleCommand(exposure, args, TAILSCALE_SERVE_TIMEOUT);
};

export const disableTailscaleServe = (
  input: {
    readonly servePort?: number;
    readonly exposure?: TailscaleExposure;
  } = {},
): Effect.Effect<void, TailscaleCommandError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
    const exposure = input.exposure ?? "serve";
    return yield* runTailscaleCommand(
      exposure,
      [exposure, `--https=${servePort}`, "off"],
      TAILSCALE_SERVE_TIMEOUT,
    );
  });

export const probeTailscaleHttpsEndpoint = (input: {
  readonly baseUrl: string;
  readonly timeout?: Duration.Input;
}): Effect.Effect<boolean, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* Effect.gen(function* () {
      const url = new URL("/.well-known/t3/environment", input.baseUrl);
      const request = HttpClientRequest.get(url.toString());
      return yield* client.execute(request);
    }).pipe(Effect.timeoutOption(input.timeout ?? TAILSCALE_PROBE_TIMEOUT));

    return Option.match(response, {
      onNone: () => false,
      onSome: (httpResponse) => httpResponse.status >= 200 && httpResponse.status < 300,
    });
  }).pipe(Effect.orElseSucceed(() => false));
