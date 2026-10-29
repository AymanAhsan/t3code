import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import type { EnvironmentShellState } from "./shell.ts";
import { waitForTeamHubThread } from "./teamHub.ts";

function shellState(threads: (typeof v2ThreadShell)[]): EnvironmentShellState {
  return {
    status: "live",
    error: Option.none(),
    snapshot: Option.some({
      schemaVersion: 1,
      snapshotSequence: 1,
      projects: [],
      threads,
      archivedThreads: [],
    }),
  };
}

describe("accepted team task navigation", () => {
  it.effect("waits until the accepted thread reaches the shell", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const shell = Atom.make(shellState([]));
      const ready = yield* Ref.make(false);
      const waiting = yield* waitForTeamHubThread(registry, shell, v2ThreadShell.id).pipe(
        Effect.andThen(Ref.set(ready, true)),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      expect(yield* Ref.get(ready)).toBe(false);
      registry.set(shell, shellState([v2ThreadShell]));
      yield* Fiber.join(waiting);
      expect(yield* Ref.get(ready)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("immediately allows a thread already present in the shell", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      yield* waitForTeamHubThread(
        registry,
        Atom.make(shellState([v2ThreadShell])),
        v2ThreadShell.id,
      );
    }).pipe(Effect.scoped),
  );
});
