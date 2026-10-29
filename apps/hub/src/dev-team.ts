#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - This developer launcher owns its local files and child processes.
/* oxlint-disable t3code/no-global-process-runtime -- Standalone launcher selects cleanup for its own host platform. */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import * as NodeUtil from "node:util";
import * as NodeCrypto from "node:crypto";
import { createHubServer } from "./server.ts";
import { HubStore } from "./store.ts";
import { loadRepoEnv } from "../../../scripts/lib/public-config.ts";

const repoRoot = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));

/** Select the workspace independently of the checkout that runs the app. */
export function resolveTeamProject(checkoutRoot: string, projectDir?: string) {
  const projectRoot = NodeFS.realpathSync(projectDir ?? checkoutRoot);
  const repo = NodeChildProcess.execFileSync("git", ["remote", "get-url", "origin"], {
    cwd: projectRoot,
    encoding: "utf8",
  }).trim();
  const demoRoot = NodePath.join(checkoutRoot, ".t3", "team-demo");
  // Keep existing default sessions; explicit targets get independent persistent state.
  const identity = JSON.stringify([projectRoot, repo]);
  const root =
    projectDir === undefined
      ? demoRoot
      : NodePath.join(
          demoRoot,
          "projects",
          NodeCrypto.createHash("sha256").update(identity).digest("hex").slice(0, 16),
        );
  return { projectRoot, repo, root };
}

/** Enroll once and preserve each session's credentials and settings across restarts. */
export function prepareTeamSessions(store: HubStore, root: string, hubUrl: string, repo: string) {
  const sessions = ["Alice", "Bob"].map((name) => {
    const home = NodePath.join(root, name.toLowerCase());
    const userdata = NodePath.join(home, "userdata");
    const secrets = NodePath.join(userdata, "secrets");
    NodeFS.mkdirSync(secrets, { recursive: true, mode: 0o700 });
    return {
      name,
      home,
      secrets,
      membershipPath: NodePath.join(secrets, "team-hub-membership.bin"),
      settingsPath: NodePath.join(userdata, "settings.json"),
    };
  });
  const alice = sessions[0]!;
  const bob = sessions[1]!;
  const enroll = (session: (typeof sessions)[number], create: () => string) => {
    if (!NodeFS.existsSync(session.membershipPath)) {
      NodeFS.writeFileSync(session.membershipPath, create(), { mode: 0o600, flag: "wx" });
    }
    const credential = NodeFS.readFileSync(session.membershipPath, "utf8");
    const member = store.authenticate(credential);
    const snapshot = store.snapshot(member, new Set());
    if (member.name !== session.name || snapshot.team.repo !== repo) {
      throw new Error(`Saved ${session.name} membership belongs to a different team/repository.`);
    }
    return member;
  };
  const admin = enroll(alice, () => {
    if (!store.setupToken) {
      throw new Error("Demo hub is already configured but Alice's credential is missing.");
    }
    return store.bootstrap(store.setupToken, "Local test team", repo, alice.name).credential;
  });
  enroll(
    bob,
    () => store.join(store.createInvite(admin, admin.team_id).token, bob.name).credential,
  );

  for (const session of sessions) {
    const settings: unknown = NodeFS.existsSync(session.settingsPath)
      ? JSON.parse(NodeFS.readFileSync(session.settingsPath, "utf8"))
      : {};
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new Error(`Invalid settings file: ${session.settingsPath}`);
    }
    NodeFS.writeFileSync(
      session.settingsPath,
      `${JSON.stringify({ ...settings, teamHubUrl: hubUrl }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  return sessions;
}

async function main() {
  const { values } = NodeUtil.parseArgs({
    options: {
      "hub-port": { type: "string", default: "8080" },
      "project-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
      "dry-run": { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(`Usage: vp run dev:team [--project-dir <path>] [--hub-port 8080] [--dry-run]

Starts the hub and Alice/Bob web + server sessions, already joined to a team.
The selected directory (default: this checkout) is added as a project in both sessions.
The app always runs from this checkout; no build is needed for another project.
State persists in .t3/team-demo, with separate state per explicit target directory/repository.
Ctrl+C stops everything started here.
Open the labeled pairing URLs printed at startup to access each session.
No browser is opened automatically. Use the Team hub settings to test Tailscale sharing.`);
    return;
  }
  const port = Number(values["hub-port"]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("--hub-port must be between 1 and 65535.");
  }
  const { projectRoot, repo, root } = resolveTeamProject(repoRoot, values["project-dir"]);
  const hubUrl = `http://127.0.0.1:${port}/`;
  if (values["dry-run"]) {
    console.log(
      `Hub: ${hubUrl}\nAlice + Bob: separate web/server instances\nState: ${root}\nProject: ${projectRoot}\nRepository: ${repo}`,
    );
    return;
  }

  NodeFS.mkdirSync(root, { recursive: true });
  const lockPath = NodePath.join(root, "launcher.lock");
  let lock: number;
  try {
    lock = NodeFS.openSync(lockPath, "wx", 0o600);
  } catch {
    throw new Error(
      `Another demo may be running. If it exited abnormally, remove ${lockPath} and retry.`,
    );
  }
  NodeFS.writeFileSync(lock, String(process.pid));
  const children: NodeChildProcess.ChildProcess[] = [];
  let store: HubStore | undefined;
  let hub: Awaited<ReturnType<typeof createHubServer>> | undefined;
  let stopping = false;
  let finish: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stop = async () => {
    if (stopping) return stopped;
    stopping = true;
    // Terminal wrappers can force-exit after Ctrl+C, so release the launcher
    // lock synchronously before waiting for sockets to close.
    NodeFS.closeSync(lock);
    NodeFS.unlinkSync(lockPath);
    console.log("[team] Stopping Alice, Bob, and the hub...");
    try {
      for (const child of children) {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
        // Only terminate trees rooted at PIDs captured by this launcher.
        if (process.platform === "win32") {
          try {
            NodeChildProcess.execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
              stdio: "ignore",
            });
          } catch {
            // The child may have exited between the check and taskkill.
          }
        } else {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            /* Already exited. */
          }
        }
      }
      await hub?.close();
      store?.close();
    } finally {
      finish();
    }
  };
  const onSignal = () => {
    void stop();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    store = new HubStore(NodePath.join(root, "hub"));
    // Bind before changing session state, so an occupied port fails without enrolling anyone.
    hub = await createHubServer(store, { host: "127.0.0.1", port });
    const sessions = prepareTeamSessions(store, root, hubUrl, repo);
    console.log(`[hub] ${hubUrl}\n[team] State: ${root}\n[team] Project: ${projectRoot}`);
    for (const [index, session] of sessions.entries()) {
      if (stopping) break;
      const env: NodeJS.ProcessEnv = {
        ...loadRepoEnv(),
        T3CODE_PORT_OFFSET: String(1000 + index * 100),
      };
      delete env.T3_SERVICE_LAUNCHER_CONTEXT;
      delete env.T3_BOOT_SERVICE_UNIT;
      delete env.T3CODE_PORT;
      const runner = NodePath.join(repoRoot, "scripts", "dev-runner.ts");
      const selection = NodeChildProcess.execFileSync(
        process.execPath,
        [runner, "dev", "--home-dir", session.home, "--host", "127.0.0.1", "--dry-run"],
        { cwd: repoRoot, env, encoding: "utf8" },
      );
      const ports = /serverPort=(\d+) webPort=(\d+)/.exec(selection);
      if (!ports) throw new Error(`Could not resolve ports for ${session.name}.`);
      env.T3CODE_PORT_OFFSET = String(Number(ports[2]) - 5733);
      const webUrl = `http://localhost:${ports[2]}`;
      // The filtered package runner changes cwd to apps/server. Start the backend
      // directly with the selected workspace as the initial project and thread.
      const commands = [
        [
          "--watch",
          NodePath.join(repoRoot, "apps", "server", "src", "bin.ts"),
          projectRoot,
          "--mode",
          "web",
          "--base-dir",
          session.home,
          "--port",
          ports[1]!,
          "--host",
          "127.0.0.1",
          "--dev-url",
          webUrl,
          "--no-browser",
          "--auto-bootstrap-project-from-cwd",
        ],
        [
          runner,
          "dev:web",
          "--home-dir",
          session.home,
          "--host",
          "127.0.0.1",
          "--port",
          ports[1]!,
          "--dev-url",
          webUrl,
        ],
      ];
      for (const args of commands) {
        const child = NodeChildProcess.spawn(process.execPath, args, {
          cwd: repoRoot,
          env,
          detached: process.platform !== "win32",
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        children.push(child);
        for (const output of [child.stdout, child.stderr]) {
          if (output)
            NodeReadline.createInterface({ input: output }).on("line", (line: string) => {
              console.log(`[${session.name}] ${line}`);
            });
        }
        child.once("error", (error) => {
          console.error(`[${session.name}] ${error.message}`);
          process.exitCode = 1;
          void stop();
        });
        child.once("exit", (code, signal) => {
          if (stopping) return;
          console.error(`[${session.name}] exited (${signal ?? code}); stopping the demo.`);
          process.exitCode = code || 1;
          void stop();
        });
      }
    }
    console.log("[team] Waiting for the labeled session pairing URLs. Press Ctrl+C to stop.");
    await stopped;
  } finally {
    await stop();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    // A failed bind in the hub can leave an internal heartbeat alive.
    // main's finally has already stopped every process owned by this launcher.
    process.exit(1);
  });
}
