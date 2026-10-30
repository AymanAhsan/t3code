import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  isProviderAvailable,
  type ModelSelection,
  type TeamHubTask,
  type ThreadId,
} from "@t3tools/contracts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TeamHubService from "./TeamHubService.ts";

export class TeamHubTaskDecisionError extends Schema.TaggedError<TeamHubTaskDecisionError>()(
  "TeamHubTaskDecisionError",
  {
    reason: Schema.Literals([
      "disconnected",
      "task_unavailable",
      "contract_pending",
      "project_missing",
      "provider_unavailable",
      "project_lookup_failed",
      "thread_launch_failed",
      "hub_failed",
      "cleanup_failed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "project_missing":
        return "Clone the team repo and add it as a project to accept tasks.";
      case "disconnected":
        return "Reconnect to the team hub before accepting tasks.";
      case "task_unavailable":
        return "This suggested task is no longer available.";
      case "contract_pending":
        return "The revised contract is waiting for the task's author to agree to it.";
      case "provider_unavailable":
        return "Choose a default provider and model before accepting tasks.";
      case "cleanup_failed":
        return "The hub rejected the task and the new thread could not be removed.";
      default:
        return "Could not accept the suggested task.";
    }
  }
}

export class TeamHubTaskDecisionService extends Context.Service<
  TeamHubTaskDecisionService,
  {
    readonly startAutomaticTasks: Effect.Effect<void>;
    readonly decideTask: (
      taskId: string,
      decision: "accepted" | "dismissed",
    ) => Effect.Effect<{ readonly threadId: ThreadId | null }, TeamHubTaskDecisionError>;
  }
>()("t3/teamHub/TeamHubTaskDecisionService") {}

/** The first message of an accepted task's thread. A contract pins the agent to the agreed file. */
export function taskPrompt(task: TeamHubTask, author: string): string {
  const lines = [task.text, "", `Suggested by ${author}.`];
  lines.push(
    "",
    `Team task: ${task.id}.`,
    "When the requested work is ready, run the relevant checks, commit and push it, then call team_complete_task with this task id, branch, full commit sha, and a short summary including the checks you ran. Ending a turn alone does not complete the task.",
  );
  const contract = task.contract;
  if (contract !== null) {
    lines.push(
      "",
      `Contract: ${contract.path} on branch ${contract.branch} at ${contract.sha}.`,
      `Fetch it first (git fetch origin ${contract.branch}) and treat that file at that commit as the source of truth for names, parameters, and responses.`,
      `If it needs to change, push a revision to ${contract.branch} and post a contract change instead of diverging from it.`,
    );
  }
  return lines.join("\n");
}

const make = Effect.gen(function* () {
  const hub = yield* TeamHubService.TeamHubService;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launch = yield* ThreadLaunch.ThreadLaunchService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const decisionLock = yield* Semaphore.make(1);
  const randomUUID = (yield* Crypto.Crypto).randomUUIDv4;

  const removeThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      yield* threads.dispatch({
        type: "thread.delete",
        commandId: CommandId.make(yield* randomUUID),
        threadId,
      });
    });

  const decideTask = Effect.fn("TeamHubTaskDecisionService.decideTask")(function* (
    taskId: string,
    decision: "accepted" | "dismissed",
    autoStartToken?: string,
  ) {
    if (decision === "dismissed") {
      yield* hub
        .decideTask(taskId, decision)
        .pipe(
          Effect.mapError((cause) => new TeamHubTaskDecisionError({ reason: "hub_failed", cause })),
        );
      return { threadId: null };
    }

    const state = yield* hub.state;
    const snapshot = state.snapshot;
    if (state.status !== "connected" || snapshot === null) {
      return yield* new TeamHubTaskDecisionError({ reason: "disconnected" });
    }
    const task = snapshot.tasks.find((item) => item.id === taskId);
    if (
      task === undefined ||
      task.status !== "suggested" ||
      (task.assigneeId !== null && task.assigneeId !== snapshot.selfId)
    ) {
      return yield* new TeamHubTaskDecisionError({ reason: "task_unavailable" });
    }
    if (task.contractAwaiting === "author") {
      return yield* new TeamHubTaskDecisionError({ reason: "contract_pending" });
    }

    const canonicalKey = normalizeGitRemoteUrl(snapshot.team.repo);
    const shells = yield* projects
      .listShells()
      .pipe(
        Effect.mapError(
          (cause) => new TeamHubTaskDecisionError({ reason: "project_lookup_failed", cause }),
        ),
      );
    const matches = shells.filter(
      (project) => project.repositoryIdentity?.canonicalKey === canonicalKey,
    );
    if (matches.length === 0) {
      return yield* new TeamHubTaskDecisionError({ reason: "project_missing" });
    }
    let project = matches[0]!;
    if (matches.length > 1) {
      const threadSnapshot = yield* threads
        .getShellSnapshot()
        .pipe(
          Effect.mapError(
            (cause) => new TeamHubTaskDecisionError({ reason: "project_lookup_failed", cause }),
          ),
        );
      const lastThreadUse = new Map<string, number>();
      for (const thread of threadSnapshot.threads) {
        const usedAt = DateTime.toEpochMillis(thread.updatedAt);
        lastThreadUse.set(
          thread.projectId,
          Math.max(lastThreadUse.get(thread.projectId) ?? 0, usedAt),
        );
      }
      const lastUsedAt = (candidate: (typeof matches)[number]) =>
        lastThreadUse.get(candidate.id) ?? Date.parse(candidate.updatedAt);
      project = matches.toSorted(
        (left, right) => lastUsedAt(right) - lastUsedAt(left) || left.id.localeCompare(right.id),
      )[0]!;
    }

    const currentSettings = yield* settings.getSettings.pipe(
      Effect.mapError(
        (cause) => new TeamHubTaskDecisionError({ reason: "project_lookup_failed", cause }),
      ),
    );
    const resolved = resolveProjectSettings(currentSettings, project.id, project).settings;
    let modelSelection: ModelSelection | null = resolved.defaultModelSelection;
    if (modelSelection === null) {
      const providers = yield* providerRegistry.getProviders;
      const provider = providers.find(
        (candidate) =>
          candidate.enabled &&
          candidate.installed &&
          candidate.status !== "error" &&
          candidate.status !== "disabled" &&
          candidate.auth.status !== "unauthenticated" &&
          isProviderAvailable(candidate),
      );
      const model =
        provider &&
        (provider.models.find((candidate) => candidate.isDefault && !candidate.isCustom)?.slug ??
          provider.models.find((candidate) => !candidate.isCustom)?.slug ??
          provider.models[0]?.slug ??
          DEFAULT_MODEL_BY_PROVIDER[provider.driver]);
      if (!provider || !model) {
        return yield* new TeamHubTaskDecisionError({ reason: "provider_unavailable" });
      }
      modelSelection = { instanceId: provider.instanceId, model };
    }

    const author =
      snapshot.members.find((member) => member.id === task.authorId)?.name ?? "a teammate";
    const commandId = CommandId.make(
      yield* randomUUID.pipe(
        Effect.mapError(
          (cause) => new TeamHubTaskDecisionError({ reason: "thread_launch_failed", cause }),
        ),
      ),
    );
    if (autoStartToken !== undefined) {
      const claim = yield* hub
        .reserveAutoStart(taskId, autoStartToken, task.contract?.sha ?? "")
        .pipe(
          Effect.mapError((cause) => new TeamHubTaskDecisionError({ reason: "hub_failed", cause })),
        );
      if (!claim.reserved) return { threadId: null };
    }
    const launchResult = yield* Effect.result(
      launch.launch({
        commandId,
        projectId: project.id,
        title: task.text.slice(0, 80),
        modelSelection,
        runtimeMode: resolved.defaultRuntimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workspaceStrategy: { type: "root" },
        initialMessage: {
          text: taskPrompt(task, author),
          attachments: [],
        },
        createdBy: "user",
        creationSource: "server",
      }),
    );
    if (Result.isFailure(launchResult)) {
      if (launchResult.failure.threadId !== undefined) {
        yield* removeThread(launchResult.failure.threadId).pipe(
          Effect.mapError(
            (cause) => new TeamHubTaskDecisionError({ reason: "cleanup_failed", cause }),
          ),
        );
      }
      return yield* new TeamHubTaskDecisionError({
        reason: "thread_launch_failed",
        cause: launchResult.failure,
      });
    }
    const launched = launchResult.success;

    const accepted = yield* Effect.result(
      hub.decideTask(taskId, "accepted", launched.threadId, autoStartToken),
    );
    if (Result.isFailure(accepted)) {
      yield* removeThread(launched.threadId).pipe(
        Effect.mapError(
          (cause) => new TeamHubTaskDecisionError({ reason: "cleanup_failed", cause }),
        ),
      );
      return yield* new TeamHubTaskDecisionError({
        reason: "hub_failed",
        cause: accepted.failure,
      });
    }
    return { threadId: launched.threadId };
  });

  return TeamHubTaskDecisionService.of({
    decideTask: (taskId, decision) =>
      decideTask(taskId, decision).pipe(decisionLock.withPermits(1)),
    startAutomaticTasks: Effect.suspend(() =>
      hub.stream.pipe(
        Stream.runForEach((state) =>
          Effect.gen(function* () {
            if (state.status !== "connected" || !state.snapshot) return;
            const snapshot = state.snapshot;
            const policy = snapshot.members.find((m) => m.id === snapshot.selfId)?.autoAccept;
            if (!policy || policy.remainingStarts <= 0) return;
            for (const task of snapshot.tasks.toSorted((a, b) => a.createdAt - b.createdAt)) {
              if (
                task.status !== "suggested" ||
                task.assigneeId !== snapshot.selfId ||
                task.autoStartAttempted ||
                !task.contract ||
                task.contractAwaiting === "author" ||
                !policy.trustedAuthorIds.includes(task.authorId)
              )
                continue;
              const token = yield* randomUUID.pipe(Effect.orDie);
              yield* decideTask(task.id, "accepted", token).pipe(
                decisionLock.withPermits(1),
                Effect.catch((error) =>
                  Effect.logWarning("Automatic team task start failed", {
                    taskId: task.id,
                    reason: error.reason,
                  }),
                ),
                Effect.ensuring(hub.releaseAutoStart(task.id, token).pipe(Effect.ignore)),
              );
            }
          }),
        ),
      ),
    ),
  });
});

export const layer = Layer.effect(TeamHubTaskDecisionService, make);
export const automaticTasksLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* TeamHubTaskDecisionService;
    yield* service.startAutomaticTasks.pipe(Effect.forkScoped);
  }),
);
