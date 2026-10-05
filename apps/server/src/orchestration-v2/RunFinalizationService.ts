import { CheckpointScopeId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as TeamHubService from "../teamHub/TeamHubService.ts";
import * as Option from "effect/Option";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class RunFinalizationError extends Schema.TaggedError<RunFinalizationError>()(
  "RunFinalizationError",
  {
    threadId: ThreadId,
    runId: RunId,
    scopeId: CheckpointScopeId,
    operation: Schema.Literals(["capture-checkpoint", "refresh-workspace"]),
    cause: Schema.Defect(),
  },
) {}

export class RunFinalizationRefreshError extends Schema.TaggedError<RunFinalizationRefreshError>()(
  "RunFinalizationRefreshError",
  { cwd: Schema.String, cause: Schema.Defect() },
) {}

export class RunFinalizationObserver extends Context.Reference<{
  readonly refreshAfterTurn: (projectId: ProjectId) => Effect.Effect<void>;
  readonly refresh: (input: {
    readonly cwd: string;
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<void, RunFinalizationRefreshError>;
}>("t3/orchestration-v2/RunFinalizationObserver", {
  defaultValue: () => ({ refresh: () => Effect.void, refreshAfterTurn: () => Effect.void }),
}) {}

export class RunFinalizationService extends Context.Service<
  RunFinalizationService,
  {
    readonly finalize: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly scopeId: CheckpointScopeId;
    }) => Effect.Effect<void, RunFinalizationError>;
  }
>()("t3/orchestration-v2/RunFinalizationService") {}

const make = Effect.gen(function* () {
  const checkpointCapture = yield* CheckpointCapture.CheckpointCaptureServiceV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const observer = yield* RunFinalizationObserver;

  const finalize: RunFinalizationService["Service"]["finalize"] = Effect.fn(
    "RunFinalizationService.finalize",
  )(function* (input) {
    yield* checkpointCapture
      .execute(input)
      .pipe(
        Effect.mapError(
          (cause) => new RunFinalizationError({ ...input, operation: "capture-checkpoint", cause }),
        ),
      );
    const projection = yield* projections
      .getCheckpointContext(input.threadId)
      .pipe(
        Effect.mapError(
          (cause) => new RunFinalizationError({ ...input, operation: "refresh-workspace", cause }),
        ),
      );
    const cwd = projection.checkpointScopes.find((scope) => scope.id === input.scopeId)?.cwd;
    if (cwd !== undefined) {
      yield* observer
        .refresh({ cwd, threadId: input.threadId, runId: input.runId })
        .pipe(
          Effect.mapError(
            (cause) =>
              new RunFinalizationError({ ...input, operation: "refresh-workspace", cause }),
          ),
        );
    }
  });
  return RunFinalizationService.of({ finalize });
});

export const layer = Layer.effect(RunFinalizationService, make);

export const observerLive = Layer.effect(
  RunFinalizationObserver,
  Effect.gen(function* () {
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    const vcsStatus = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const pullRequests = yield* PullRequestService.PullRequestService;
    const hub = yield* Effect.serviceOption(TeamHubService.TeamHubService);
    const repositoryIdentity = yield* Effect.serviceOption(
      RepositoryIdentityResolver.RepositoryIdentityResolver,
    );
    return {
      refreshAfterTurn: pullRequests.refreshAfterTurn,
      refresh: ({ cwd, threadId, runId }) =>
        Effect.gen(function* () {
          const [, local] = yield* Effect.all(
            [workspaceEntries.refresh(cwd), vcsStatus.refreshLocalStatus(cwd)],
            { concurrency: "unbounded" },
          );
          if (Option.isSome(hub) && Option.isSome(repositoryIdentity) && local.refName) {
            yield* Effect.gen(function* () {
              const repository = yield* repositoryIdentity.value.resolve(cwd);
              if (!repository) return;
              const records = yield* projections.getThreadRecords(threadId, ["checkpoints"]);
              const latest = records.checkpoints
                .filter((checkpoint) => checkpoint.runId === runId && checkpoint.status === "ready")
                .toSorted((a, b) => b.ordinalWithinScope - a.ordinalWithinScope)[0];
              if (!latest) return;
              const completedThread = yield* projections.getThreadShell(threadId);
              yield* hub.value.publishCheckpoint({
                repository: repository.canonicalKey,
                branch: local.refName!,
                files: latest.files.map((file) => file.path),
                description: completedThread?.title || "Checkpoint captured",
              });
            }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Could not publish team checkpoint summary", { cause }),
              ),
            );
          }
          if (local.refName === null || local.isDefaultRef) return;
          const thread = yield* projections.getThreadShell(threadId);
          if (!thread || thread.branch !== local.refName) return;
          if (thread.activeRunId !== null && thread.activeRunId !== runId) return;
          yield* vcsStatus.refreshPullRequestStatus(cwd).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to refresh pull request status after run completion", {
                threadId,
                cwd,
                detail: error.message,
              }),
            ),
          );
        }).pipe(Effect.mapError((cause) => new RunFinalizationRefreshError({ cwd, cause }))),
    };
  }),
);
