// @effect-diagnostics nodeBuiltinImport:off - Tests use isolated temporary SQLite databases.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { HubStore } from "./store.ts";

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
    });
    const before = store.snapshot(bobMember, new Set()).tasks[0];
    expect(before?.status).toBe("suggested");
    expect(() => store.decideTask(alice, before!.id, "accepted")).toThrow();
    store.decideTask(bobMember, before!.id, "accepted");
    expect(store.snapshot(bobMember, new Set()).tasks[0]?.status).toBe("accepted");
    store.close();
  });
});
