import type {
  ProjectId,
  TeamHubContractRef,
  TeamHubTaskResult,
  ThreadId,
} from "@t3tools/contracts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { routeAssignee } from "./routeAssignee.ts";
import * as TeamHubService from "./TeamHubService.ts";

export class TeamHubDelegationError extends Schema.TaggedError<TeamHubDelegationError>()(
  "TeamHubDelegationError",
  {
    reason: Schema.Literals([
      "disconnected",
      "project_mismatch",
      "no_assignee",
      "ambiguous_assignee",
      "contract_not_pushed",
      "result_not_pushed",
      "completion_unavailable",
      "task_unavailable",
      "hub_failed",
    ]),
    path: Schema.optional(Schema.String),
    detail: Schema.optional(Schema.String),
    candidates: Schema.optional(Schema.Array(Schema.String)),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "disconnected":
        return "This environment is not connected to a team hub.";
      case "project_mismatch":
        return "The calling project does not match the team repository.";
      case "no_assignee":
        return `No teammate owns ${this.path}. Pass assigneeId, or ask teammates to set their areas in Settings → Team hub.`;
      case "ambiguous_assignee":
        return `Several teammates own ${this.path}: ${this.candidates?.join(", ")}. Pass assigneeId to pick one.`;
      case "contract_not_pushed":
        return "The contract commit is not on the remote branch yet. Push the contract branch first.";
      case "result_not_pushed":
        return "The result commit is not on the remote branch yet. Push the work branch first.";
      case "completion_unavailable":
        return "Only the accepted task's thread can complete it.";
      case "task_unavailable":
        return "That task is not a suggested contract task you are part of.";
      case "hub_failed":
        return this.detail === undefined
          ? "The team hub rejected the task."
          : `The team hub rejected it: ${this.detail}`;
    }
  }
}

/** Posts teammate tasks, routing contract tasks by domain and pinning them to a pushed commit. */
export class TeamHubDelegationService extends Context.Service<
  TeamHubDelegationService,
  {
    readonly postTask: (input: {
      readonly projectId: ProjectId;
      readonly text: string;
      readonly assigneeId: string | null;
      readonly contract: TeamHubContractRef | null;
    }) => Effect.Effect<{ readonly assigneeId: string | null }, TeamHubDelegationError>;
    /**
     * Agrees to a contract task's current commit, or proposes a new commit on the same branch
     * and path. A revision must be pushed first, the same as when posting.
     */
    readonly reviewContract: (input: {
      readonly projectId: ProjectId;
      readonly taskId: string;
      readonly decision: "agree" | "revise";
      readonly sha: string;
    }) => Effect.Effect<void, TeamHubDelegationError>;
    readonly completeTask: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly taskId: string;
      readonly result: TeamHubTaskResult;
    }) => Effect.Effect<void, TeamHubDelegationError>;
    readonly reopenTask: (input: {
      readonly projectId: ProjectId;
      readonly taskId: string;
    }) => Effect.Effect<void, TeamHubDelegationError>;
  }
>()("t3/teamHub/TeamHubDelegationService") {}

const make = Effect.gen(function* () {
  const hub = yield* TeamHubService.TeamHubService;
  const projects = yield* ProjectService.ProjectService;
  const git = yield* GitVcsDriver.GitVcsDriver;

  const projectRoot = (projectId: ProjectId, repo: string) =>
    Effect.gen(function* () {
      const project = yield* projects
        .getShell(projectId, { resolveRepositoryIdentity: true })
        .pipe(Effect.orElseSucceed(Option.none));
      if (
        Option.isNone(project) ||
        project.value.repositoryIdentity?.canonicalKey !== normalizeGitRemoteUrl(repo)
      ) {
        return yield* new TeamHubDelegationError({ reason: "project_mismatch" });
      }
      return project.value.workspaceRoot;
    });

  const hubFailed = (cause: TeamHubService.TeamHubError) =>
    new TeamHubDelegationError({ reason: "hub_failed", detail: cause.reason, cause });

  // True when `sha` is the remote branch tip or one of its ancestors.
  const isPushed = (cwd: string, contract: { readonly branch: string; readonly sha: string }) =>
    Effect.gen(function* () {
      const remote = yield* git.resolvePrimaryRemoteName(cwd);
      const fetched = yield* git.execute({
        operation: "TeamHubDelegationService.fetchContractBranch",
        cwd,
        args: ["fetch", "--quiet", "--no-tags", remote, `refs/heads/${contract.branch}`],
        allowNonZeroExit: true,
      });
      if (fetched.exitCode !== 0) return false;
      const ancestor = yield* git.execute({
        operation: "TeamHubDelegationService.checkContractCommit",
        cwd,
        args: ["merge-base", "--is-ancestor", contract.sha, "FETCH_HEAD"],
        allowNonZeroExit: true,
      });
      return ancestor.exitCode === 0;
    }).pipe(Effect.orElseSucceed(() => false));

  const postTask: TeamHubDelegationService["Service"]["postTask"] = Effect.fn(
    "TeamHubDelegationService.postTask",
  )(function* ({ projectId, text, assigneeId, contract }) {
    const snapshot = (yield* hub.state).snapshot;
    if (snapshot === null) return yield* new TeamHubDelegationError({ reason: "disconnected" });
    const workspaceRoot = yield* projectRoot(projectId, snapshot.team.repo);

    let assignee = assigneeId;
    if (contract !== null) {
      if (assignee === null) {
        const routed = routeAssignee(snapshot.members, snapshot.selfId, [contract.path]);
        if (routed.assigneeId === null) {
          return yield* new TeamHubDelegationError({
            reason: routed.candidates.length === 0 ? "no_assignee" : "ambiguous_assignee",
            path: contract.path,
            candidates: routed.candidates.map((member) => `${member.name} (${member.id})`),
          });
        }
        assignee = routed.assigneeId;
      }
      if (!(yield* isPushed(workspaceRoot, contract))) {
        return yield* new TeamHubDelegationError({ reason: "contract_not_pushed" });
      }
    }

    yield* hub
      .publish({ type: "post_task", text, assigneeId: assignee, contract })
      .pipe(Effect.mapError(hubFailed));
    return { assigneeId: assignee };
  });

  const reviewContract: TeamHubDelegationService["Service"]["reviewContract"] = Effect.fn(
    "TeamHubDelegationService.reviewContract",
  )(function* ({ projectId, taskId, decision, sha }) {
    const snapshot = (yield* hub.state).snapshot;
    if (snapshot === null) return yield* new TeamHubDelegationError({ reason: "disconnected" });
    const workspaceRoot = yield* projectRoot(projectId, snapshot.team.repo);
    const task = snapshot.tasks.find((item) => item.id === taskId);
    if (
      task === undefined ||
      task.status !== "suggested" ||
      task.contract === null ||
      (task.authorId !== snapshot.selfId && task.assigneeId !== snapshot.selfId)
    ) {
      return yield* new TeamHubDelegationError({ reason: "task_unavailable" });
    }
    if (decision === "revise" && !(yield* isPushed(workspaceRoot, { ...task.contract, sha }))) {
      return yield* new TeamHubDelegationError({ reason: "contract_not_pushed" });
    }
    yield* hub
      .publish({
        type: decision === "agree" ? "agree_contract" : "revise_contract",
        taskId,
        sha,
      })
      .pipe(Effect.mapError(hubFailed));
  });

  const completeTask: TeamHubDelegationService["Service"]["completeTask"] = Effect.fn(
    "TeamHubDelegationService.completeTask",
  )(function* ({ projectId, threadId, taskId, result }) {
    const snapshot = (yield* hub.state).snapshot;
    if (snapshot === null) return yield* new TeamHubDelegationError({ reason: "disconnected" });
    const cwd = yield* projectRoot(projectId, snapshot.team.repo);
    const task = snapshot.tasks.find((task) => task.id === taskId);
    if (
      !task ||
      task.status !== "accepted" ||
      task.assigneeId !== snapshot.selfId ||
      task.threadId !== threadId
    ) {
      return yield* new TeamHubDelegationError({ reason: "completion_unavailable" });
    }
    if (!(yield* isPushed(cwd, result)))
      return yield* new TeamHubDelegationError({ reason: "result_not_pushed" });
    yield* hub.publish({ type: "complete_task", taskId, result }).pipe(Effect.mapError(hubFailed));
  });

  const reopenTask: TeamHubDelegationService["Service"]["reopenTask"] = Effect.fn(
    "TeamHubDelegationService.reopenTask",
  )(function* ({ projectId, taskId }) {
    const snapshot = (yield* hub.state).snapshot;
    if (snapshot === null) return yield* new TeamHubDelegationError({ reason: "disconnected" });
    yield* projectRoot(projectId, snapshot.team.repo);
    yield* hub.publish({ type: "reopen_task", taskId }).pipe(Effect.mapError(hubFailed));
  });

  return TeamHubDelegationService.of({ postTask, reviewContract, completeTask, reopenTask });
});

export const layer = Layer.effect(TeamHubDelegationService, make);
