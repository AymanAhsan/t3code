// @effect-diagnostics nodeBuiltinImport:off - Tests use isolated temporary SQLite databases.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { HubStore } from "./store.ts";
import { ThreadId } from "@t3tools/contracts";

const dirs: string[] = [];
const open = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-team-hub-"));
  dirs.push(dir);
  return { dir, store: new HubStore(dir) };
};

afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

describe("team hub store", () => {
  it("links accepted threads and progress, persists completion, and supports reopening and completing again", () => {
    const { dir, store } = open();
    const admin = store.bootstrap(store.setupToken!, "Team", "repo", "Alice");
    const alice = store.authenticate(admin.credential);
    const bob = store.authenticate(
      store.join(store.createInvite(alice, alice.team_id).token, "Bob").credential,
    );
    const eve = store.authenticate(
      store.join(store.createInvite(alice, alice.team_id).token, "Eve").credential,
    );
    store.publish(alice, {
      type: "post_task",
      assigneeId: null,
      text: "Build API",
      contract: null,
    });
    const taskId = store.snapshot(alice, new Set()).tasks[0]!.id;
    const result = {
      branch: "work/api",
      sha: "a".repeat(40),
      description: "Built API; contract tests passed",
    };
    const complete = { type: "complete_task" as const, taskId, result };
    expect(() => store.publish(bob, complete)).toThrow();
    const threadId = ThreadId.make("bob-thread");
    store.decideTask(bob, taskId, "accepted", threadId);
    expect(store.snapshot(alice, new Set()).tasks[0]).toMatchObject({
      assigneeId: bob.id,
      threadId,
      contractAwaiting: null,
    });
    expect(() => store.publish(alice, complete)).toThrow("assignee");
    expect(() => store.publish(eve, complete)).toThrow("assignee");
    store.publish(bob, {
      type: "publish_summary",
      taskId,
      branch: result.branch,
      files: ["api.ts"],
      description: "Progress",
    });
    expect(store.snapshot(alice, new Set()).tasks[0]?.status).toBe("accepted");
    expect(store.snapshot(alice, new Set()).summaries[0]?.taskId).toBe(taskId);
    store.publish(bob, complete);
    expect(() => store.publish(bob, complete)).toThrow("accepted");
    store.close();
    const reopened = new HubStore(dir);
    try {
      expect(reopened.snapshot(alice, new Set()).tasks[0]).toMatchObject({
        status: "done",
        result,
        threadId,
      });
      expect(reopened.snapshot(alice, new Set()).summaries).toHaveLength(2);
      expect(() => reopened.publish(eve, { type: "reopen_task", taskId })).toThrow(
        "author or assignee",
      );
      reopened.publish(alice, { type: "reopen_task", taskId });
      expect(reopened.snapshot(alice, new Set()).tasks[0]).toMatchObject({
        status: "accepted",
        result: null,
        threadId,
      });
      expect(() => reopened.publish(alice, { type: "reopen_task", taskId })).toThrow("completed");
      reopened.publish(bob, complete);
      reopened.publish(bob, { type: "reopen_task", taskId });
      expect(reopened.snapshot(alice, new Set()).tasks[0]?.status).toBe("accepted");
    } finally {
      reopened.close();
    }
  });

  it("bootstraps once and preserves the setup link across an interrupted first start", () => {
    const { dir, store } = open();
    const token = store.setupToken;
    expect(token).not.toBeNull();
    store.close();
    const restarted = new HubStore(dir);
    expect(restarted.setupToken).toBe(token);
    const admin = restarted.bootstrap(token!, "Engineering", "github.com/example/repo", "Alice");
    expect(restarted.authenticate(admin.credential).role).toBe("admin");
    expect(() => restarted.bootstrap(token!, "Other", "repo", "Bob")).toThrow();
    restarted.close();
    const configured = new HubStore(dir);
    expect(configured.setupToken).toBeNull();
    configured.close();
  });

  it("persists admin repository edits without changing membership or coordination history", () => {
    const { dir, store } = open();
    const admin = store.bootstrap(store.setupToken!, "Engineering", "old-repo", "Alice");
    const alice = store.authenticate(admin.credential);
    const bob = store.join(store.createInvite(alice, admin.team.id).token, "Bob");
    const member = store.authenticate(bob.credential);
    store.publish(alice, { type: "post_note", text: "Keep this note" });
    expect(() => store.updateRepo(member, "unauthorized-repo")).toThrow("Admin required");
    for (const invalid of ["", "   ", "x".repeat(257)]) {
      expect(() => store.updateRepo(alice, invalid)).toThrow("Invalid repository");
    }
    expect(store.snapshot(alice, new Set()).team.repo).toBe("old-repo");
    store.updateRepo(alice, " https://github.com/example/new-repo ");
    store.close();
    const reopened = new HubStore(dir);
    try {
      const snapshot = reopened.snapshot(reopened.authenticate(bob.credential), new Set());
      expect(snapshot.team).toEqual({ ...admin.team, repo: "https://github.com/example/new-repo" });
      expect(snapshot.members).toHaveLength(2);
      expect(snapshot.notes[0]?.text).toBe("Keep this note");
    } finally {
      reopened.close();
    }
  });

  it("uses expiring single-use invites and revocable credentials", () => {
    const { store } = open();
    const admin = store.bootstrap(
      store.setupToken!,
      "Engineering",
      "github.com/example/repo",
      "Alice",
    );
    const adminMember = store.authenticate(admin.credential);
    const invite = store.createInvite(adminMember, admin.team.id);
    const joined = store.join(invite.token, "Bob");
    expect(() => store.join(invite.token, "Eve")).toThrow();
    expect(store.authenticate(joined.credential).name).toBe("Bob");
    const revoked = store.createInvite(adminMember, admin.team.id);
    store.revokeInvite(adminMember, admin.team.id, revoked.id);
    expect(() => store.join(revoked.token, "Eve")).toThrow();
    store.removeMember(adminMember, admin.team.id, joined.memberId);
    expect(() => store.authenticate(joined.credential)).toThrow();
    store.close();
  });

  it("keeps file claims exclusive and teammate tasks suggested until a member accepts", () => {
    const { store } = open();
    const admin = store.bootstrap(
      store.setupToken!,
      "Engineering",
      "github.com/example/repo",
      "Alice",
    );
    const alice = store.authenticate(admin.credential);
    const bob = store.join(store.createInvite(alice, admin.team.id).token, "Bob");
    const bobMember = store.authenticate(bob.credential);
    store.publish(alice, { type: "claim_files", paths: ["src/api.ts"] });
    expect(() =>
      store.publish(bobMember, { type: "claim_files", paths: ["src/api.ts"] }),
    ).toThrow();
    store.publish(alice, {
      type: "post_task",
      assigneeId: bob.memberId,
      text: "Update the client",
      contract: null,
    });
    const before = store.snapshot(bobMember, new Set()).tasks[0];
    expect(before?.status).toBe("suggested");
    expect(() => store.decideTask(alice, before!.id, "accepted")).toThrow();
    store.decideTask(bobMember, before!.id, "accepted");
    expect(store.snapshot(bobMember, new Set()).tasks[0]?.status).toBe("accepted");
    store.close();
  });
  it("routes tasks with a pinned contract and keeps each member's domains their own", () => {
    const { dir, store } = open();
    const admin = store.bootstrap(store.setupToken!, "Engineering", "repo", "Alice");
    const alice = store.authenticate(admin.credential);
    const bob = store.join(store.createInvite(alice, admin.team.id).token, "Bob");
    const bobMember = store.authenticate(bob.credential);
    store.publish(bobMember, { type: "set_domains", domains: ["apps/api/**", "apps/api/**"] });
    const contract = {
      branch: "contract/login-api",
      path: "api/auth.openapi.yaml",
      sha: "a".repeat(40),
    };
    store.publish(alice, {
      type: "post_task",
      assigneeId: bob.memberId,
      text: "Build the login API",
      contract,
    });
    store.close();
    const reopened = new HubStore(dir);
    try {
      const snapshot = reopened.snapshot(reopened.authenticate(admin.credential), new Set());
      expect(snapshot.members.find((m) => m.id === bob.memberId)?.domains).toEqual(["apps/api/**"]);
      expect(snapshot.members.find((m) => m.id === alice.id)?.domains).toEqual([]);
      expect(snapshot.tasks[0]?.contract).toEqual(contract);
    } finally {
      reopened.close();
    }
  });

  it("adds new columns to a hub database created before domains and contracts", () => {
    const { dir, store } = open();
    const admin = store.bootstrap(store.setupToken!, "Engineering", "repo", "Alice");
    const alice = store.authenticate(admin.credential);
    store.publish(alice, { type: "post_task", assigneeId: null, text: "Old task", contract: null });
    store.publish(alice, {
      type: "publish_summary",
      branch: "main",
      files: [],
      description: "Old summary",
    });
    store.close();
    const db = new NodeSqlite.DatabaseSync(NodePath.join(dir, "hub.sqlite"));
    db.exec(
      "ALTER TABLE members DROP COLUMN domains_json; ALTER TABLE tasks DROP COLUMN contract_json; ALTER TABLE tasks DROP COLUMN contract_awaiting; ALTER TABLE tasks DROP COLUMN thread_id; ALTER TABLE tasks DROP COLUMN result_json; ALTER TABLE summaries DROP COLUMN task_id;",
    );
    db.close();
    const migrated = new HubStore(dir);
    try {
      const snapshot = migrated.snapshot(migrated.authenticate(admin.credential), new Set());
      expect(snapshot.members[0]?.domains).toEqual([]);
      expect(snapshot.tasks[0]).toMatchObject({
        text: "Old task",
        contract: null,
        contractAwaiting: null,
        threadId: null,
        result: null,
      });
      expect(snapshot.summaries[0]).toMatchObject({ description: "Old summary", taskId: null });
    } finally {
      migrated.close();
    }
  });

  it("only lets the assignee accept a contract both sides agreed to", () => {
    const { store } = open();
    const admin = store.bootstrap(store.setupToken!, "Engineering", "repo", "Alice");
    const alice = store.authenticate(admin.credential);
    const bob = store.authenticate(
      store.join(store.createInvite(alice, admin.team.id).token, "Bob").credential,
    );
    const carol = store.authenticate(
      store.join(store.createInvite(alice, admin.team.id).token, "Carol").credential,
    );
    const contract = { branch: "contract/login-api", path: "api/auth.yaml", sha: "a".repeat(40) };
    store.publish(alice, { type: "post_task", assigneeId: bob.id, text: "Login API", contract });
    const task = () => store.snapshot(alice, new Set()).tasks[0]!;
    expect(task().contractAwaiting).toBe("assignee");

    // Bob revises; now Alice has to agree before Bob can accept.
    store.publish(bob, { type: "revise_contract", taskId: task().id, sha: "b".repeat(40) });
    expect(task()).toMatchObject({
      contract: { ...contract, sha: "b".repeat(40) },
      contractAwaiting: "author",
    });
    expect(() => store.decideTask(bob, task().id, "accepted")).toThrow(/waiting on/);
    expect(() =>
      store.publish(carol, { type: "agree_contract", taskId: task().id, sha: "b".repeat(40) }),
    ).toThrow(/author or assignee/);
    expect(() =>
      store.publish(bob, { type: "agree_contract", taskId: task().id, sha: "b".repeat(40) }),
    ).toThrow(/not waiting on you/);
    expect(() =>
      store.publish(alice, { type: "agree_contract", taskId: task().id, sha: "a".repeat(40) }),
    ).toThrow(/changed/);

    store.publish(alice, { type: "agree_contract", taskId: task().id, sha: "b".repeat(40) });
    expect(task().contractAwaiting).toBeNull();
    store.decideTask(bob, task().id, "accepted");
    expect(task()).toMatchObject({ status: "accepted", contract: { sha: "b".repeat(40) } });
    expect(() =>
      store.publish(alice, { type: "revise_contract", taskId: task().id, sha: "c".repeat(40) }),
    ).toThrow(/unavailable/);
    store.close();
  });
});
