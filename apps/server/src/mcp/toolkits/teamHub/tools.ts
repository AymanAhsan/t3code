import {
  OrchestratorMcpFailure,
  TeamHubContractChange,
  TeamHubMember,
  TeamHubNote,
  TeamHubSummary,
  TeamHubTask,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
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
  ],
};

const TeamInbox = Tool.make("team_inbox", {
  ...shared,
  description:
    "Read teammates, recent summaries, notes, and suggested tasks for this team's repository.",
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
    "Post a short note or suggest a task to a teammate. Tasks require the human recipient to accept them.",
  parameters: Schema.Struct({
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    kind: Schema.Literals(["note", "task"]),
    assigneeId: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({ posted: Schema.Boolean }),
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

const ListContractChanges = Tool.make("list_contract_changes", {
  ...shared,
  description: "List recent route, schema, API, and contract file changes reported by teammates.",
  success: Schema.Struct({ changes: Schema.Array(TeamHubContractChange) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const TeamHubToolkit = Toolkit.make(TeamInbox, TeamPost, ClaimFiles, ListContractChanges);
