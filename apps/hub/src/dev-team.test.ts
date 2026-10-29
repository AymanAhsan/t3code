// @effect-diagnostics nodeBuiltinImport:off - Tests use isolated temporary demo state.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { afterEach, expect, it } from "vite-plus/test";
import { prepareTeamSessions, resolveTeamProject } from "./dev-team.ts";
import { HubStore } from "./store.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

function createRepository(root: string, directory: string, origin: string) {
  const project = NodePath.join(root, directory);
  NodeFS.mkdirSync(project, { recursive: true });
  NodeChildProcess.execFileSync("git", ["init", "--quiet", project]);
  NodeChildProcess.execFileSync("git", ["remote", "add", "origin", origin], { cwd: project });
  return project;
}

it("keeps target repositories isolated and resumes their saved memberships", () => {
  const checkout = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-dev-team-"));
  roots.push(checkout);
  const first = createRepository(checkout, "first/project", "https://example.com/first");
  const second = createRepository(checkout, "second/project", "https://example.com/second");
  const credentials: string[] = [];
  const selections = [first, second].map((project) => resolveTeamProject(checkout, project));
  expect(selections[0]!.root).not.toBe(selections[1]!.root);
  for (const selection of selections) {
    const store = new HubStore(NodePath.join(selection.root, "hub"));
    try {
      const sessions = prepareTeamSessions(
        store,
        selection.root,
        "http://localhost:8080/",
        selection.repo,
      );
      credentials.push(NodeFS.readFileSync(sessions[0]!.membershipPath, "utf8"));
      expect(store.snapshot(store.authenticate(credentials.at(-1)!), new Set()).team.repo).toBe(
        selection.repo,
      );
    } finally {
      store.close();
    }
  }
  const resumed = resolveTeamProject(checkout, NodePath.join(first, "."));
  expect(resumed.root).toBe(selections[0]!.root);
  const store = new HubStore(NodePath.join(resumed.root, "hub"));
  try {
    const sessions = prepareTeamSessions(
      store,
      resumed.root,
      "http://localhost:8080/",
      resumed.repo,
    );
    expect(NodeFS.readFileSync(sessions[0]!.membershipPath, "utf8")).toBe(credentials[0]);
    expect(() => store.authenticate(credentials[1]!)).toThrow();
  } finally {
    store.close();
  }
  NodeChildProcess.execFileSync(
    "git",
    ["remote", "set-url", "origin", "https://example.com/changed"],
    { cwd: first },
  );
  expect(resolveTeamProject(checkout, first).root).not.toBe(resumed.root);
});

it("preserves the default state location and previews a relative target without creating state", () => {
  const checkout = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-dev-team-"));
  roots.push(checkout);
  createRepository(checkout, ".", "https://example.com/app");
  const target = createRepository(checkout, "target project", "https://example.com/target");
  expect(resolveTeamProject(checkout).root).toBe(NodePath.join(checkout, ".t3", "team-demo"));
  const output = NodeChildProcess.execFileSync(
    process.execPath,
    [
      NodeURL.fileURLToPath(new URL("./dev-team.ts", import.meta.url)),
      "--project-dir",
      "target project",
      "--dry-run",
    ],
    { cwd: checkout, encoding: "utf8" },
  );
  expect(output).toContain(`Project: ${NodeFS.realpathSync(target)}`);
  expect(output).toContain("Repository: https://example.com/target");
  expect(output).toContain(`${NodePath.sep}team-demo${NodePath.sep}projects${NodePath.sep}`);
  expect(NodeFS.existsSync(NodePath.join(checkout, ".t3"))).toBe(false);
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
