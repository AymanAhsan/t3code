import { OrchestratorMcpFailure, type ProjectId } from "@t3tools/contracts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as TeamHubService from "../../../teamHub/TeamHubService.ts";
import { readCaller, readMutationCaller, unavailable } from "../../threadAccess.ts";
import { TeamHubToolkit } from "./tools.ts";

const snapshot = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const hub = yield* TeamHubService.TeamHubService;
    const state = yield* hub.state;
    if (!state.snapshot) {
      return yield* new OrchestratorMcpFailure({
        code: "provider_unavailable",
        message: state.error ?? "This environment is not connected to a team hub.",
      });
    }
    const projects = yield* ProjectService.ProjectService;
    const project = yield* projects.getShell(projectId).pipe(Effect.mapError(unavailable));
    if (
      Option.isNone(project) ||
      project.value.repositoryIdentity?.canonicalKey !==
        normalizeGitRemoteUrl(state.snapshot.team.repo)
    ) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "The calling project does not match the team repository.",
      });
    }
    return state.snapshot;
  });

export const TeamHubHandlersLive = TeamHubToolkit.toLayer({
  team_inbox: () =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      const current = yield* snapshot(caller.projectId);
      return {
        members: current.members,
        summaries: current.summaries,
        notes: current.notes,
        tasks: current.tasks.filter(
          (task) =>
            task.status === "suggested" &&
            (task.assigneeId === null || task.assigneeId === current.selfId),
        ),
      };
    }),
  team_post: ({ text, kind, assigneeId }) =>
    Effect.gen(function* () {
      const { caller } = yield* readMutationCaller();
      const hub = yield* TeamHubService.TeamHubService;
      yield* snapshot(caller.projectId);
      yield* hub
        .publish(
          kind === "note"
            ? { type: "post_note", text }
            : { type: "post_task", text, assigneeId: assigneeId ?? null },
        )
        .pipe(Effect.mapError(unavailable));
      return { posted: true };
    }),
  claim_files: ({ paths, action }) =>
    Effect.gen(function* () {
      const { caller } = yield* readMutationCaller();
      const hub = yield* TeamHubService.TeamHubService;
      yield* snapshot(caller.projectId);
      yield* hub
        .publish({
          type: action === "claim" ? "claim_files" : "release_files",
          paths,
        })
        .pipe(Effect.mapError(unavailable));
      return { sent: true };
    }),
  list_contract_changes: () =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      return { changes: (yield* snapshot(caller.projectId)).contractChanges };
    }),
});
