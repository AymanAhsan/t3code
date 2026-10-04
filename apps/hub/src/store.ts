// @effect-diagnostics nodeBuiltinImport:off globalDate:off - The standalone hub owns its SQLite and wall clock boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import type {
  TeamHubClaim,
  TeamHubClientMessage,
  TeamHubContractChange,
  TeamHubMember,
  TeamHubNote,
  TeamHubSnapshot,
  TeamHubSummary,
  TeamHubTask,
} from "@t3tools/contracts/teamHub";

type TeamRow = { id: string; name: string; repo: string };
type MemberRow = { id: string; team_id: string; name: string; role: "admin" | "member" };
type SummaryRow = {
  id: string;
  member_id: string;
  branch: string;
  files_json: string;
  description: string;
  created_at: number;
};
type TaskRow = {
  id: string;
  author_id: string;
  assignee_id: string | null;
  text: string;
  status: "suggested" | "accepted" | "dismissed";
  created_at: number;
};
type NoteRow = { id: string; member_id: string; text: string; created_at: number };
type ContractRow = {
  id: string;
  member_id: string;
  description: string;
  paths_json: string;
  created_at: number;
};
type ClaimRow = { path: string; member_id: string; expires_at: number };

const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const secret = () => NodeCrypto.randomBytes(32).toString("base64url");
const now = () => Date.now();

export class HubError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export class HubStore {
  readonly db: NodeSqlite.DatabaseSync;
  readonly setupToken: string | null;
  private readonly signingKey: string;

  constructor(dataDir: string) {
    NodeFS.mkdirSync(dataDir, { recursive: true });
    this.db = new NodeSqlite.DatabaseSync(NodePath.join(dataDir, "hub.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), name TEXT NOT NULL,
        role TEXT NOT NULL, credential_hash TEXT NOT NULL UNIQUE, revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS members_team ON members(team_id);
      CREATE TABLE IF NOT EXISTS invites (
        id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id),
        expires_at INTEGER NOT NULL, used_at INTEGER, revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS summaries (
        id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id),
        member_id TEXT NOT NULL REFERENCES members(id), branch TEXT NOT NULL,
        files_json TEXT NOT NULL, description TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS summaries_team ON summaries(team_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id),
        author_id TEXT NOT NULL REFERENCES members(id), assignee_id TEXT REFERENCES members(id),
        text TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_team ON tasks(team_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id),
        member_id TEXT NOT NULL REFERENCES members(id), text TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS notes_team ON notes(team_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS claims (
        team_id TEXT NOT NULL REFERENCES teams(id), path TEXT NOT NULL,
        member_id TEXT NOT NULL REFERENCES members(id), expires_at INTEGER NOT NULL,
        PRIMARY KEY (team_id, path)
      );
      CREATE TABLE IF NOT EXISTS contract_changes (
        id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id),
        member_id TEXT NOT NULL REFERENCES members(id), description TEXT NOT NULL,
        paths_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS contracts_team ON contract_changes(team_id, created_at DESC);
    `);
    const storedKey = this.db.prepare("SELECT value FROM meta WHERE key='signing_key'").get() as
      | { value: string }
      | undefined;
    this.signingKey = storedKey?.value ?? secret();
    if (!storedKey) {
      this.db.prepare("INSERT INTO meta (key,value) VALUES ('signing_key',?)").run(this.signingKey);
    }
    const teamCount = this.db.prepare("SELECT COUNT(*) AS count FROM teams").get() as {
      count: number;
    };
    const setup = this.db.prepare("SELECT value FROM meta WHERE key='setup_hash'").get() as
      | { value: string }
      | undefined;
    this.setupToken =
      teamCount.count === 0
        ? NodeCrypto.createHmac("sha256", this.signingKey)
            .update("first-team-setup")
            .digest("base64url")
        : null;
    if (this.setupToken && !setup) {
      this.db
        .prepare("INSERT INTO meta (key,value) VALUES ('setup_hash',?)")
        .run(hash(this.setupToken));
    }
  }

  close() {
    this.db.close();
  }

  bootstrap(token: string, name: string, repo: string, displayName: string) {
    const setup = this.db.prepare("SELECT value FROM meta WHERE key='setup_hash'").get() as
      | { value: string }
      | undefined;
    if (!setup || hash(token) !== setup.value) throw new HubError("Invalid setup link", 403);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT 1 FROM teams LIMIT 1").get()) {
        throw new HubError("Hub is already configured", 409);
      }
      const team = this.createTeamRow(name, repo);
      const member = this.createMember(team.id, displayName, "admin");
      this.db.prepare("DELETE FROM meta WHERE key='setup_hash'").run();
      this.db.exec("COMMIT");
      return { team, ...member };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private createTeamRow(name: string, repo: string): TeamRow {
    const team = { id: NodeCrypto.randomUUID(), name, repo };
    this.db.prepare("INSERT INTO teams VALUES (?,?,?,?)").run(team.id, name, repo, now());
    return team;
  }

  createTeam(admin: MemberRow, name: string, repo: string) {
    if (admin.role !== "admin") throw new HubError("Admin required", 403);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const team = this.createTeamRow(name, repo);
      const member = this.createMember(team.id, admin.name, "admin");
      this.db.exec("COMMIT");
      return { team, ...member };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private createMember(teamId: string, name: string, role: "admin" | "member") {
    const credential = secret();
    const memberId = NodeCrypto.randomUUID();
    this.db
      .prepare("INSERT INTO members (id,team_id,name,role,credential_hash) VALUES (?,?,?,?,?)")
      .run(memberId, teamId, name, role, hash(credential));
    return { memberId, credential };
  }

  authenticate(credential: string): MemberRow {
    if (credential.length > 256) throw new HubError("Invalid credential", 401);
    const member = this.db
      .prepare(
        "SELECT id,team_id,name,role FROM members WHERE credential_hash=? AND revoked_at IS NULL",
      )
      .get(hash(credential)) as MemberRow | undefined;
    if (!member) throw new HubError("Invalid credential", 401);
    return member;
  }

  createInvite(admin: MemberRow, teamId: string, lifetimeMs = 86_400_000) {
    this.requireAdmin(admin, teamId);
    const id = NodeCrypto.randomUUID();
    const expiresAt = now() + lifetimeMs;
    this.db
      .prepare("INSERT INTO invites (id,team_id,expires_at) VALUES (?,?,?)")
      .run(id, teamId, expiresAt);
    const payload = Buffer.from(JSON.stringify({ id, teamId, expiresAt })).toString("base64url");
    const signature = NodeCrypto.createHmac("sha256", this.signingKey)
      .update(payload)
      .digest("base64url");
    return { id, token: `${payload}.${signature}`, expiresAt };
  }

  revokeInvite(admin: MemberRow, teamId: string, inviteId: string) {
    this.requireAdmin(admin, teamId);
    const result = this.db
      .prepare("UPDATE invites SET revoked_at=? WHERE id=? AND team_id=? AND used_at IS NULL")
      .run(now(), inviteId, teamId);
    if (!result.changes) throw new HubError("Invite not found", 404);
  }

  listInvites(admin: MemberRow) {
    this.requireAdmin(admin, admin.team_id);
    return this.db
      .prepare(
        "SELECT id,expires_at AS expiresAt,used_at AS usedAt,revoked_at AS revokedAt FROM invites WHERE team_id=? ORDER BY expires_at DESC LIMIT 100",
      )
      .all(admin.team_id);
  }

  join(token: string, displayName: string) {
    const [payload, signature] = token.split(".");
    if (!payload || !signature || token.length > 1000) throw new HubError("Invalid invite", 403);
    const expected = NodeCrypto.createHmac("sha256", this.signingKey).update(payload).digest();
    const supplied = Buffer.from(signature, "base64url");
    if (expected.length !== supplied.length || !NodeCrypto.timingSafeEqual(expected, supplied)) {
      throw new HubError("Invalid invite", 403);
    }
    let decoded: { id: string; teamId: string; expiresAt: number };
    try {
      decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof decoded;
    } catch {
      throw new HubError("Invalid invite", 403);
    }
    if (
      typeof decoded.id !== "string" ||
      typeof decoded.teamId !== "string" ||
      typeof decoded.expiresAt !== "number" ||
      decoded.expiresAt <= now()
    ) {
      throw new HubError("Invite expired", 403);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const used = this.db
        .prepare(
          "UPDATE invites SET used_at=? WHERE id=? AND team_id=? AND expires_at=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?",
        )
        .run(now(), decoded.id, decoded.teamId, decoded.expiresAt, now());
      if (!used.changes) throw new HubError("Invite used, expired, or revoked", 403);
      const member = this.createMember(decoded.teamId, displayName, "member");
      this.db.exec("COMMIT");
      return { teamId: decoded.teamId, ...member };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  removeMember(admin: MemberRow, teamId: string, memberId: string) {
    this.requireAdmin(admin, teamId);
    if (admin.id === memberId) throw new HubError("Cannot remove yourself", 400);
    const result = this.db
      .prepare("UPDATE members SET revoked_at=? WHERE id=? AND team_id=? AND revoked_at IS NULL")
      .run(now(), memberId, teamId);
    if (!result.changes) throw new HubError("Member not found", 404);
    this.db.prepare("DELETE FROM claims WHERE team_id=? AND member_id=?").run(teamId, memberId);
  }

  private requireAdmin(member: MemberRow, teamId: string) {
    if (member.role !== "admin" || member.team_id !== teamId) {
      throw new HubError("Admin required", 403);
    }
  }

  snapshot(member: MemberRow, onlineIds: ReadonlySet<string>): TeamHubSnapshot {
    const team = this.db
      .prepare("SELECT id,name,repo FROM teams WHERE id=?")
      .get(member.team_id) as TeamRow;
    const members = this.db
      .prepare("SELECT id,team_id,name,role FROM members WHERE team_id=? AND revoked_at IS NULL")
      .all(member.team_id) as MemberRow[];
    const summaries = this.db
      .prepare(
        "SELECT id,member_id,branch,files_json,description,created_at FROM summaries WHERE team_id=? ORDER BY created_at DESC LIMIT 50",
      )
      .all(member.team_id) as SummaryRow[];
    const tasks = this.db
      .prepare(
        "SELECT id,author_id,assignee_id,text,status,created_at FROM tasks WHERE team_id=? ORDER BY created_at DESC LIMIT 100",
      )
      .all(member.team_id) as TaskRow[];
    const notes = this.db
      .prepare(
        "SELECT id,member_id,text,created_at FROM notes WHERE team_id=? ORDER BY created_at DESC LIMIT 100",
      )
      .all(member.team_id) as NoteRow[];
    const claims = this.db
      .prepare(
        "SELECT path,member_id,expires_at FROM claims WHERE team_id=? AND expires_at>? ORDER BY path",
      )
      .all(member.team_id, now()) as ClaimRow[];
    const changes = this.db
      .prepare(
        "SELECT id,member_id,description,paths_json,created_at FROM contract_changes WHERE team_id=? ORDER BY created_at DESC LIMIT 50",
      )
      .all(member.team_id) as ContractRow[];
    return {
      team,
      selfId: member.id,
      members: members.map((row): TeamHubMember => ({
        id: row.id,
        name: row.name,
        role: row.role,
        online: onlineIds.has(row.id),
      })),
      summaries: summaries.map((row): TeamHubSummary => ({
        id: row.id,
        memberId: row.member_id,
        branch: row.branch,
        files: JSON.parse(row.files_json) as string[],
        description: row.description,
        createdAt: row.created_at,
      })),
      tasks: tasks.map((row): TeamHubTask => ({
        id: row.id,
        authorId: row.author_id,
        assigneeId: row.assignee_id,
        text: row.text,
        status: row.status,
        createdAt: row.created_at,
      })),
      notes: notes.map((row): TeamHubNote => ({
        id: row.id,
        memberId: row.member_id,
        text: row.text,
        createdAt: row.created_at,
      })),
      claims: claims.map((row): TeamHubClaim => ({
        path: row.path,
        memberId: row.member_id,
        expiresAt: row.expires_at,
      })),
      contractChanges: changes.map((row): TeamHubContractChange => ({
        id: row.id,
        memberId: row.member_id,
        description: row.description,
        paths: JSON.parse(row.paths_json) as string[],
        createdAt: row.created_at,
      })),
    };
  }

  publish(member: MemberRow, message: TeamHubClientMessage) {
    const createdAt = now();
    const id = NodeCrypto.randomUUID();
    switch (message.type) {
      case "publish_summary":
        this.db
          .prepare("INSERT INTO summaries VALUES (?,?,?,?,?,?,?)")
          .run(
            id,
            member.team_id,
            member.id,
            message.branch,
            JSON.stringify(message.files),
            message.description,
            createdAt,
          );
        break;
      case "post_task":
        if (
          message.assigneeId &&
          !this.db
            .prepare("SELECT 1 FROM members WHERE id=? AND team_id=? AND revoked_at IS NULL")
            .get(message.assigneeId, member.team_id)
        ) {
          throw new HubError("Assignee not in team", 400);
        }
        this.db
          .prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?,?)")
          .run(
            id,
            member.team_id,
            member.id,
            message.assigneeId,
            message.text,
            "suggested",
            createdAt,
          );
        break;
      case "post_note":
        this.db
          .prepare("INSERT INTO notes VALUES (?,?,?,?,?)")
          .run(id, member.team_id, member.id, message.text, createdAt);
        break;
      case "claim_files":
        this.db.exec("BEGIN IMMEDIATE");
        try {
          for (const path of new Set(message.paths)) {
            const prior = this.db
              .prepare("SELECT member_id,expires_at FROM claims WHERE team_id=? AND path=?")
              .get(member.team_id, path) as { member_id: string; expires_at: number } | undefined;
            if (prior && prior.expires_at > createdAt && prior.member_id !== member.id) {
              throw new HubError(`File already claimed: ${path}`, 409);
            }
            this.db
              .prepare(
                "INSERT INTO claims VALUES (?,?,?,?) ON CONFLICT(team_id,path) DO UPDATE SET member_id=excluded.member_id,expires_at=excluded.expires_at",
              )
              .run(member.team_id, path, member.id, createdAt + 3_600_000);
          }
          this.db.exec("COMMIT");
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
        break;
      case "release_files":
        for (const path of new Set(message.paths)) {
          this.db
            .prepare("DELETE FROM claims WHERE team_id=? AND path=? AND member_id=?")
            .run(member.team_id, path, member.id);
        }
        break;
      case "post_contract_change":
        this.db
          .prepare("INSERT INTO contract_changes VALUES (?,?,?,?,?,?)")
          .run(
            id,
            member.team_id,
            member.id,
            message.description,
            JSON.stringify(message.paths),
            createdAt,
          );
        break;
    }
  }

  decideTask(member: MemberRow, taskId: string, decision: "accepted" | "dismissed") {
    const result = this.db
      .prepare(
        "UPDATE tasks SET status=? WHERE id=? AND team_id=? AND status='suggested' AND (assignee_id IS NULL OR assignee_id=?)",
      )
      .run(decision, taskId, member.team_id, member.id);
    if (!result.changes) throw new HubError("Task unavailable", 404);
  }
}
