import {
  OrchestratorMcpFailure,
  TeamHubContractChange,
  TeamHubContractRef,
  TeamHubDomains,
  TeamHubMember,
  TeamHubNote,
  TeamHubSummary,
  TeamHubTask,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as TeamHubDelegationService from "../../../teamHub/TeamHubDelegationService.ts";
import * as TeamHubService from "../../../teamHub/TeamHubService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    TeamHubService.TeamHubService,
    TeamHubDelegationService.TeamHubDelegationService,
  ],
};

const TeamInbox = Tool.make("team_inbox", {
  ...shared,
  description:
    "Read teammates, recent summaries, notes, and suggested tasks for this team's repository. Each teammate's domains are the repository path globs they own. " +
    "Tasks include ones suggested to you and contract tasks you posted whose contract is waiting on your review (`contractAwaiting` is `author`).",
  success: Schema.Struct({
    members: Schema.Array(TeamHubMember),
    summaries: Schema.Array(TeamHubSummary),
    notes: Schema.Array(TeamHubNote),
    tasks: Schema.Array(TeamHubTask),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const TeamPost = Tool.make("team_post", {
  ...shared,
  description:
    "Post a short note or suggest a task to a teammate. Tasks require the human recipient to accept them. " +
    "To delegate work that crosses an interface, such as a backend API for your frontend, first commit the agreed contract file " +
    "(for example an OpenAPI or schema file) to a branch and push it, then pass `contract` with that branch, the file path, and the full commit sha. " +
    "Without assigneeId, a contract task goes to the one teammate whose domains own the contract path. " +
    "The assignee can agree by accepting, or revise the contract with team_review_contract.",
  parameters: Schema.Struct({
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    kind: Schema.Literals(["note", "task"]),
    assigneeId: Schema.optional(Schema.String),
    contract: Schema.optional(TeamHubContractRef),
  }),
  success: Schema.Struct({ posted: Schema.Boolean, assigneeId: Schema.NullOr(Schema.String) }),
}).annotate(Tool.Destructive, false);

const ClaimFiles = Tool.make("claim_files", {
  ...shared,
  description:
    "Claim or release repository-relative files. Claims expire after one hour and conflict with teammates' active claims.",
  parameters: Schema.Struct({
    paths: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))).check(
      Schema.isMaxLength(50),
    ),
    action: Schema.Literals(["claim", "release"]),
  }),
  success: Schema.Struct({ sent: Schema.Boolean }),
}).annotate(Tool.Destructive, false);

const SetDomains = Tool.make("team_set_domains", {
  ...shared,
  description:
    "Replace the repository path globs (such as `apps/api/**`) this teammate owns. Teammates' agents route contract tasks by these. Pass an empty list to clear.",
  parameters: Schema.Struct({ domains: TeamHubDomains }),
  success: Schema.Struct({ sent: Schema.Boolean }),
}).annotate(Tool.Destructive, false);

const ReviewContract = Tool.make("team_review_contract", {
  ...shared,
  description:
    "Review the contract of a suggested contract task you posted or were assigned. Read the file at the task's sha first. " +
    "`agree` approves that exact sha. `revise` proposes a new commit: commit the changed contract file to the same branch and path, push it, " +
    "then pass the full sha. A revision goes back to the other side, and the assignee can only accept once both sides agreed to the same sha.",
  parameters: Schema.Struct({
    taskId: Schema.String,
    decision: Schema.Literals(["agree", "revise"]),
    sha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  }),
  success: Schema.Struct({ sent: Schema.Boolean }),
}).annotate(Tool.Destructive, false);

const ListContractChanges = Tool.make("list_contract_changes", {
  ...shared,
  description: "List recent route, schema, API, and contract file changes reported by teammates.",
  success: Schema.Struct({ changes: Schema.Array(TeamHubContractChange) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const TeamHubToolkit = Toolkit.make(
  TeamInbox,
  TeamPost,
  ClaimFiles,
  SetDomains,
  ReviewContract,
  ListContractChanges,
);
