import type {
  OrchestrationV2ThreadShell,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import type { TeamHubActivity } from "@t3tools/contracts/teamHub";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as TeamHubService from "./TeamHubService.ts";

type ActivityThread = Pick<
  OrchestrationV2ThreadShell,
  "providerInstanceId" | "activeRunId" | "latestRunRequestedAt"
>;

const requestedAt = (thread: ActivityThread) =>
  thread.latestRunRequestedAt ? DateTime.toEpochMillis(thread.latestRunRequestedAt) : -1;

/**
 * Whether any agent on this machine is running, and the driver of the one the user ran most
 * recently. A running thread wins over a newer idle one, so the buddy shows what is working.
 */
export function resolveTeamHubActivity(
  threads: ReadonlyArray<ActivityThread>,
  driverOf: (instanceId: ProviderInstanceId) => ProviderDriverKind | null,
): TeamHubActivity {
  const ran = threads.filter((thread) => thread.latestRunRequestedAt);
  const working = ran.filter((thread) => thread.activeRunId !== null);
  const latest = (working.length > 0 ? working : ran).reduce<ActivityThread | null>(
    (best, thread) => (best === null || requestedAt(thread) > requestedAt(best) ? thread : best),
    null,
  );
  return {
    provider: latest ? driverOf(latest.providerInstanceId) : null,
    working: working.length > 0,
  };
}

// Events that can start or end a run, or change which agent a thread uses.
const ACTIVITY_EVENTS = new Set<string>([
  "run.created",
  "run.updated",
  "thread.provider-switched",
  "thread.archived",
  "thread.deleted",
]);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const hub = yield* TeamHubService.TeamHubService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;

    const report = Effect.gen(function* () {
      const [shell, instances] = yield* Effect.all([
        threads.getShellSnapshot({ location: "active" }),
        registry.listInstances,
      ]);
      const drivers = new Map(
        instances.map((instance) => [instance.instanceId, instance.driverKind]),
      );
      yield* hub.reportActivity(
        resolveTeamHubActivity(shell.threads, (id) => drivers.get(id) ?? null),
      );
    }).pipe(
      Effect.catch((cause) => Effect.logWarning("Could not report team activity", { cause })),
    );

    yield* report;
    yield* threads.streamDomainEvents.pipe(
      Stream.filter((event) => ACTIVITY_EVENTS.has(event.type)),
      // A turn emits a burst of run updates; one report after it settles is enough.
      Stream.debounce(Duration.millis(500)),
      Stream.runForEach(() => report),
      Effect.forkScoped,
    );
  }),
);
