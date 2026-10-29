// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Tests use isolated SQLite databases and real local HTTP/WebSocket sockets.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { TEAM_HUB_PROTOCOL_VERSION } from "@t3tools/contracts/teamHub";
import { createHubServer } from "./server.ts";
import { HubStore } from "./store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve) =>
    socket.once("message", (data) => resolve(JSON.parse(data.toString()) as unknown)),
  );
}

describe("team hub server", () => {
  it("rejects conflicting file claims through the acknowledged publish endpoint", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-team-hub-claim-"));
    dirs.push(dir);
    const store = new HubStore(dir);
    const admin = store.bootstrap(
      store.setupToken!,
      "Engineering",
      "github.com/example/repo",
      "Alice",
    );
    const bob = store.join(
      store.createInvite(store.authenticate(admin.credential), admin.team.id).token,
      "Bob",
    );
    const server = await createHubServer(store, { host: "127.0.0.1", port: 0 });
    const publish = (credential: string) =>
      fetch(`http://127.0.0.1:${server.port}/api/publish`, {
        method: "POST",
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
        body: JSON.stringify({ type: "claim_files", paths: ["src/api.ts"] }),
      });
    try {
      expect((await publish(admin.credential)).status).toBe(200);
      const conflict = await publish(bob.credential);
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toEqual({ error: "File already claimed: src/api.ts" });
      const page = await fetch(`http://127.0.0.1:${server.port}/join`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Settings → Integrations → Team hub");
    } finally {
      await server.close();
      store.close();
    }
  });

  it("syncs presence, summaries, and admin repository edits to connected teammates", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-team-hub-socket-"));
    dirs.push(dir);
    const store = new HubStore(dir);
    const admin = store.bootstrap(
      store.setupToken!,
      "Engineering",
      "github.com/example/repo",
      "Alice",
    );
    const alice = store.authenticate(admin.credential);
    const bob = store.join(store.createInvite(alice, admin.team.id).token, "Bob");
    const server = await createHubServer(store, { host: "127.0.0.1", port: 0 });
    const url = `ws://127.0.0.1:${server.port}/ws?version=${TEAM_HUB_PROTOCOL_VERSION}`;
    const aliceSocket = new WebSocket(url);
    const bobSocket = new WebSocket(url);
    try {
      await Promise.all([
        new Promise<void>((resolve) => aliceSocket.once("open", resolve)),
        new Promise<void>((resolve) => bobSocket.once("open", resolve)),
      ]);
      const aliceInitial = nextMessage(aliceSocket);
      aliceSocket.send(JSON.stringify({ type: "hello", credential: admin.credential }));
      await aliceInitial;
      const bobInitial = nextMessage(bobSocket);
      const alicePresence = nextMessage(aliceSocket);
      bobSocket.send(JSON.stringify({ type: "hello", credential: bob.credential }));
      await bobInitial;
      const presence = (await alicePresence) as { snapshot: { members: { online: boolean }[] } };
      expect(presence.snapshot.members.every((member) => member.online)).toBe(true);
      const updateRepo = (credential: string, repo: unknown) =>
        fetch(`http://127.0.0.1:${server.port}/api/team/repo`, {
          method: "POST",
          headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
          body: JSON.stringify({ repo }),
        });
      expect((await updateRepo(bob.credential, "forbidden")).status).toBe(403);
      for (const invalid of [null, "   ", "x".repeat(257)]) {
        expect((await updateRepo(admin.credential, invalid)).status).toBe(400);
      }
      const aliceRepo = nextMessage(aliceSocket);
      const bobRepo = nextMessage(bobSocket);
      expect(
        (await updateRepo(admin.credential, "https://github.com/example/new-repo")).status,
      ).toBe(200);
      for (const update of await Promise.all([aliceRepo, bobRepo])) {
        expect(update).toMatchObject({
          snapshot: { team: { repo: "https://github.com/example/new-repo" } },
        });
      }
      const bobSummary = nextMessage(bobSocket);
      aliceSocket.send(
        JSON.stringify({
          type: "publish_summary",
          branch: "feature/team",
          files: ["src/api.ts"],
          description: "Updated API",
        }),
      );
      const snapshot = (await bobSummary) as { snapshot: { summaries: { branch: string }[] } };
      expect(snapshot.snapshot.summaries[0]?.branch).toBe("feature/team");
    } finally {
      aliceSocket.terminate();
      bobSocket.terminate();
      await server.close();
      store.close();
    }
  });

  it("drops a client that stops answering pings and keeps one that does", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-team-hub-heartbeat-"));
    dirs.push(dir);
    const store = new HubStore(dir);
    const admin = store.bootstrap(
      store.setupToken!,
      "Engineering",
      "github.com/example/repo",
      "Alice",
    );
    const bob = store.join(
      store.createInvite(store.authenticate(admin.credential), admin.team.id).token,
      "Bob",
    );
    const server = await createHubServer(store, { host: "127.0.0.1", port: 0, heartbeatMs: 50 });
    const url = `ws://127.0.0.1:${server.port}/ws?version=${TEAM_HUB_PROTOCOL_VERSION}`;
    const responsive = new WebSocket(url);
    const silent = new WebSocket(url, { autoPong: false });
    try {
      await Promise.all([
        new Promise<void>((resolve) => responsive.once("open", resolve)),
        new Promise<void>((resolve) => silent.once("open", resolve)),
      ]);
      const closed = new Promise<void>((resolve) => silent.once("close", () => resolve()));
      let responsiveClosed = false;
      responsive.once("close", () => (responsiveClosed = true));
      responsive.send(JSON.stringify({ type: "hello", credential: admin.credential }));
      silent.send(JSON.stringify({ type: "hello", credential: bob.credential }));
      await closed;
      expect(responsiveClosed).toBe(false);
      expect(responsive.readyState).toBe(WebSocket.OPEN);
    } finally {
      responsive.terminate();
      silent.terminate();
      await server.close();
      store.close();
    }
  });

  it("rejects incompatible protocol versions before upgrading", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-team-hub-version-"));
    dirs.push(dir);
    const store = new HubStore(dir);
    const server = await createHubServer(store, { host: "127.0.0.1", port: 0 });
    try {
      const status = await new Promise<number>((resolve) => {
        const socket = new WebSocket(
          `ws://127.0.0.1:${server.port}/ws?version=${TEAM_HUB_PROTOCOL_VERSION - 1}`,
        );
        socket.once("unexpected-response", (_request, response) => {
          resolve(response.statusCode ?? 0);
          response.resume();
        });
      });
      expect(status).toBe(426);
    } finally {
      await server.close();
      store.close();
    }
  });
});
