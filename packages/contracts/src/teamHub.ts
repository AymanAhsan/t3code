import * as Schema from "effect/Schema";

export const TEAM_HUB_PROTOCOL_VERSION = 1;

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Id = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/));

export const TeamHubMember = Schema.Struct({
  id: Id,
  name: Text,
  role: Schema.Literals(["admin", "member"]),
  online: Schema.Boolean,
});
export type TeamHubMember = typeof TeamHubMember.Type;

export const TeamHubSummary = Schema.Struct({
  id: Id,
  memberId: Id,
  branch: Schema.String,
  files: Schema.Array(Schema.String),
  description: Schema.String,
  createdAt: Schema.Number,
});
export type TeamHubSummary = typeof TeamHubSummary.Type;

export const TeamHubTask = Schema.Struct({
  id: Id,
  authorId: Id,
  assigneeId: Schema.NullOr(Id),
  text: Text,
  status: Schema.Literals(["suggested", "accepted", "dismissed"]),
  createdAt: Schema.Number,
});
export type TeamHubTask = typeof TeamHubTask.Type;

export const TeamHubNote = Schema.Struct({
  id: Id,
  memberId: Id,
  text: Text,
  createdAt: Schema.Number,
});
export type TeamHubNote = typeof TeamHubNote.Type;

export const TeamHubClaim = Schema.Struct({
  path: Text,
  memberId: Id,
  expiresAt: Schema.Number,
});
export type TeamHubClaim = typeof TeamHubClaim.Type;

export const TeamHubContractChange = Schema.Struct({
  id: Id,
  memberId: Id,
  description: Text,
  paths: Schema.Array(Schema.String),
  createdAt: Schema.Number,
});
export type TeamHubContractChange = typeof TeamHubContractChange.Type;

export const TeamHubSnapshot = Schema.Struct({
  team: Schema.Struct({ id: Id, name: Text, repo: Text }),
  selfId: Id,
  members: Schema.Array(TeamHubMember),
  summaries: Schema.Array(TeamHubSummary),
  tasks: Schema.Array(TeamHubTask),
  notes: Schema.Array(TeamHubNote),
  claims: Schema.Array(TeamHubClaim),
  contractChanges: Schema.Array(TeamHubContractChange),
});
export type TeamHubSnapshot = typeof TeamHubSnapshot.Type;

export const TeamHubState = Schema.Struct({
  url: Schema.NullOr(Schema.String),
  status: Schema.Literals(["disconnected", "connecting", "connected"]),
  snapshot: Schema.NullOr(TeamHubSnapshot),
  error: Schema.NullOr(Schema.String),
});
export type TeamHubState = typeof TeamHubState.Type;

export const TeamHubJoinInput = Schema.Struct({
  url: Text,
  token: Text,
  displayName: Text,
});
export type TeamHubJoinInput = typeof TeamHubJoinInput.Type;

export const TeamHubBootstrapInput = Schema.Struct({
  url: Text,
  token: Text,
  teamName: Text,
  repo: Text,
  displayName: Text,
});
export type TeamHubBootstrapInput = typeof TeamHubBootstrapInput.Type;

export const TeamHubInvite = Schema.Struct({ id: Id, token: Text, expiresAt: Schema.Number });
export type TeamHubInvite = typeof TeamHubInvite.Type;
export const TeamHubInviteRecord = Schema.Struct({
  id: Id,
  expiresAt: Schema.Number,
  usedAt: Schema.NullOr(Schema.Number),
  revokedAt: Schema.NullOr(Schema.Number),
});
export type TeamHubInviteRecord = typeof TeamHubInviteRecord.Type;
export const TeamHubRevokeInviteInput = Schema.Struct({ inviteId: Id });

export const TeamHubRemoveMemberInput = Schema.Struct({ memberId: Id });
export const TeamHubTaskDecisionInput = Schema.Struct({
  taskId: Id,
  decision: Schema.Literals(["accepted", "dismissed"]),
});

export const TeamHubPublishSummary = Schema.Struct({
  type: Schema.Literal("publish_summary"),
  branch: Schema.String.check(Schema.isMaxLength(256)),
  files: Schema.Array(Schema.String.check(Schema.isMaxLength(512))).check(Schema.isMaxLength(200)),
  description: Schema.String.check(Schema.isMaxLength(1000)),
});
export type TeamHubPublishSummary = typeof TeamHubPublishSummary.Type;

export const TeamHubPostTask = Schema.Struct({
  type: Schema.Literal("post_task"),
  assigneeId: Schema.NullOr(Id),
  text: Text,
});
export type TeamHubPostTask = typeof TeamHubPostTask.Type;

export const TeamHubPostNote = Schema.Struct({
  type: Schema.Literal("post_note"),
  text: Text,
});
export type TeamHubPostNote = typeof TeamHubPostNote.Type;

export const TeamHubClaimFiles = Schema.Struct({
  type: Schema.Literal("claim_files"),
  paths: Schema.Array(Text).check(Schema.isMaxLength(50)),
});
export type TeamHubClaimFiles = typeof TeamHubClaimFiles.Type;

export const TeamHubReleaseFiles = Schema.Struct({
  type: Schema.Literal("release_files"),
  paths: Schema.Array(Text).check(Schema.isMaxLength(50)),
});
export type TeamHubReleaseFiles = typeof TeamHubReleaseFiles.Type;

export const TeamHubPostContractChange = Schema.Struct({
  type: Schema.Literal("post_contract_change"),
  description: Text,
  paths: Schema.Array(Text).check(Schema.isMaxLength(50)),
});
export type TeamHubPostContractChange = typeof TeamHubPostContractChange.Type;

export const TeamHubClientMessage = Schema.Union([
  TeamHubPublishSummary,
  TeamHubPostTask,
  TeamHubPostNote,
  TeamHubClaimFiles,
  TeamHubReleaseFiles,
  TeamHubPostContractChange,
]);
export type TeamHubClientMessage = typeof TeamHubClientMessage.Type;
