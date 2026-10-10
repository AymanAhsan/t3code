import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

const encoder = new TextEncoder();

function mockHandle(result: { stdout?: string; stderr?: string; code?: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

// The executable name depends on the host platform (`tailscale.exe` on
// Windows), so pin it: these tests assert the posix spelling.
export function spawnerLayer(spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) {
  return Layer.merge(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(HostProcessPlatform, "linux"),
  );
}

/** A handler returns "not-found" for a command that does not exist on this machine. */
export function mockSpawnerLayer(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => { stdout?: string; stderr?: string; code?: number } | "not-found",
) {
  return spawnerLayer(
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      const result = handler(childProcess.command, childProcess.args);
      return result === "not-found"
        ? Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
            }),
          )
        : Effect.succeed(mockHandle(result));
    }),
  );
}
