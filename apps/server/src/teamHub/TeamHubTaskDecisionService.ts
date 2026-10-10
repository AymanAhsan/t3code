import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  isProviderAvailable,
  type ModelSelection,
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
    readonly decideTask: (
      taskId: string,
      decision: "accepted" | "dismissed",
    ) => Effect.Effect<{ readonly threadId: ThreadId | null }, TeamHubTaskDecisionError>;
  }
>()("t3/teamHub/TeamHubTaskDecisionService") {}

const make = Effect.gen(function* () {
  const hub = yield* TeamHubService.TeamHubService;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launch = yield* ThreadLaunch.ThreadLaunchService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const randomUUID = (yield* Crypto.Crypto).randomUUIDv4;

  const removeThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      yield* threads.dispatch({
        type: "thread.delete",
        commandId: CommandId.make(yield* randomUUID),
        threadId,
      });
    });

  const decideTask: TeamHubTaskDecisionService["Service"]["decideTask"] = Effect.fn(
    "TeamHubTaskDecisionService.decideTask",
  )(function* (taskId, decision) {
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
          text: `${task.text}\n\nSuggested by ${author}.`,
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

    const accepted = yield* Effect.result(hub.decideTask(taskId, "accepted"));
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

  return TeamHubTaskDecisionService.of({ decideTask });
});

export const layer = Layer.effect(TeamHubTaskDecisionService, make);
