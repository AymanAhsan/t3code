// @effect-diagnostics nodeBuiltinImport:off - Tests use isolated temporary demo state.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { prepareTeamSessions } from "./dev-team.ts";
import { HubStore } from "./store.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

it("enrolls Alice and Bob with distinct persistent credentials and preserves their settings and tasks", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-dev-team-"));
  roots.push(root);
  const hubDir = NodePath.join(root, "hub");
  const store = new HubStore(hubDir);
  let sessions: ReturnType<typeof prepareTeamSessions>;
  let credentials: string[];
  try {
    sessions = prepareTeamSessions(
      store,
      root,
      "http://127.0.0.1:8080/",
      "https://example.com/repo",
    );
    credentials = sessions.map((session) => NodeFS.readFileSync(session.membershipPath, "utf8"));
    expect(new Set(credentials).size).toBe(2);
    const alice = store.authenticate(credentials[0]!);
    const bob = store.authenticate(credentials[1]!);
    expect(alice.name).toBe("Alice");
    expect(alice.role).toBe("admin");
    expect(bob.name).toBe("Bob");
    expect(bob.role).toBe("member");
    expect(bob.team_id).toBe(alice.team_id);
    store.publish(bob, {
      type: "post_task",
      text: "Review the demo",
      assigneeId: alice.id,
      contract: null,
    });
    NodeFS.writeFileSync(
      sessions[0]!.settingsPath,
      JSON.stringify({ teamHubUrl: "old", customSetting: true }),
    );
  } finally {
    store.close();
  }
  const restarted = new HubStore(hubDir);
  try {
    const again = prepareTeamSessions(
      restarted,
      root,
      "http://127.0.0.1:9090/",
      "https://example.com/repo",
    );
    expect(again.map((session) => NodeFS.readFileSync(session.membershipPath, "utf8"))).toEqual(
      credentials!,
    );
    expect(JSON.parse(NodeFS.readFileSync(again[0]!.settingsPath, "utf8"))).toEqual({
      teamHubUrl: "http://127.0.0.1:9090/",
      customSetting: true,
    });
    const snapshot = restarted.snapshot(restarted.authenticate(credentials![0]!), new Set());
    expect(snapshot.members).toHaveLength(2);
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]?.text).toBe("Review the demo");
    expect(() =>
      prepareTeamSessions(restarted, root, "http://127.0.0.1:9090/", "other-repo"),
    ).toThrow("different team/repository");
  } finally {
    restarted.close();
  }
});
