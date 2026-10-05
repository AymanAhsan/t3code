// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off - The standalone hub binds a Node HTTP and WebSocket process.
import * as NodeHttp from "node:http";
import type * as NodeStream from "node:stream";
import { Schema } from "effect";
import WebSocket, { WebSocketServer } from "ws";
import { TEAM_HUB_PROTOCOL_VERSION, TeamHubClientMessage } from "@t3tools/contracts/teamHub";
import { HubError, HubStore } from "./store.ts";

const decodeClientMessage = Schema.decodeUnknownSync(TeamHubClientMessage);

type Connected = {
  socket: WebSocket;
  member: ReturnType<HubStore["authenticate"]>;
  credential: string;
};

function json(response: NodeHttp.ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function handoffPage(response: NodeHttp.ServerResponse, kind: "setup" | "join") {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  });
  response.end(
    `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Team hub ${kind}</title><main style="max-width:32rem;margin:4rem auto;font:16px system-ui;padding:0 1rem"><h1>${kind === "setup" ? "Set up your team hub" : "Join a team hub"}</h1><p>Open T3 Code, go to Settings → Integrations → Team hub, and paste this complete link${kind === "setup" ? " under Set up a hub" : " under Join team"}. The token after # stays in your browser until you paste it into T3 Code.</p><p>Keep this link private. It can be used once.</p></main></html>`,
  );
}

async function body(request: NodeHttp.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > 64 * 1024) throw new HubError("Request too large", 413);
    chunks.push(bytes);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Return one consistent error for malformed and non-object JSON.
  }
  throw new HubError("Invalid JSON body", 400);
}

function string(value: unknown, name: string, max = 256) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new HubError(`Invalid ${name}`, 400);
  }
  return value.trim();
}

function authenticate(store: HubStore, request: NodeHttp.IncomingMessage) {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization ?? "");
  if (!match?.[1]) throw new HubError("Credential required", 401);
  return store.authenticate(match[1]);
}

function rejectUpgrade(socket: NodeStream.Duplex, status: number, message: string) {
  socket.end(
    `HTTP/1.1 ${status} ${status === 426 ? "Upgrade Required" : "Bad Request"}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${message}`,
  );
}

// Proxies such as Tailscale Funnel drop idle sockets, so the hub pings every client and
// terminates the ones that miss a pong. `heartbeatMs` is overridable for tests.
export async function createHubServer(
  store: HubStore,
  options: { host: string; port: number; heartbeatMs?: number },
) {
  const connections = new Set<Connected>();
  const alive = new WeakSet<WebSocket>();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024,
    perMessageDeflate: false,
  });
  const online = (teamId: string) =>
    new Set(
      [...connections]
        .filter((item) => item.member.team_id === teamId)
        .map((item) => item.member.id),
    );
  const broadcast = (teamId: string) => {
    for (const connection of connections) {
      if (connection.member.team_id !== teamId || connection.socket.readyState !== WebSocket.OPEN)
        continue;
      connection.socket.send(
        JSON.stringify({
          type: "snapshot",
          protocolVersion: TEAM_HUB_PROTOCOL_VERSION,
          snapshot: store.snapshot(connection.member, online(teamId)),
        }),
      );
    }
  };
  const server = NodeHttp.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://hub.local");
      if (request.method === "GET" && url.pathname === "/health") {
        return json(response, 200, { ok: true, protocolVersion: TEAM_HUB_PROTOCOL_VERSION });
      }
      if (request.method === "GET" && (url.pathname === "/setup" || url.pathname === "/join")) {
        return handoffPage(response, url.pathname === "/setup" ? "setup" : "join");
      }
      if (request.method === "POST" && url.pathname === "/api/bootstrap") {
        const input = await body(request);
        const result = store.bootstrap(
          string(input.token, "setup token", 1000),
          string(input.teamName, "team name"),
          string(input.repo, "repository"),
          string(input.displayName, "display name"),
        );
        return json(response, 201, result);
      }
      if (request.method === "POST" && url.pathname === "/api/join") {
        const input = await body(request);
        const result = store.join(
          string(input.token, "invite token", 1000),
          string(input.displayName, "display name"),
        );
        broadcast(result.teamId);
        return json(response, 201, result);
      }
      if (request.method === "GET" && url.pathname === "/api/snapshot") {
        const member = authenticate(store, request);
        return json(response, 200, store.snapshot(member, online(member.team_id)));
      }
      if (request.method === "POST" && url.pathname === "/api/publish") {
        const member = authenticate(store, request);
        let message;
        try {
          message = decodeClientMessage(await body(request));
        } catch {
          throw new HubError("Invalid team message", 400);
        }
        store.publish(member, message);
        broadcast(member.team_id);
        return json(response, 200, { ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/invites") {
        const member = authenticate(store, request);
        const invite = store.createInvite(member, member.team_id);
        return json(response, 201, invite);
      }
      if (request.method === "POST" && url.pathname === "/api/teams") {
        const member = authenticate(store, request);
        const input = await body(request);
        return json(
          response,
          201,
          store.createTeam(
            member,
            string(input.teamName, "team name"),
            string(input.repo, "repository"),
          ),
        );
      }
      if (request.method === "POST" && url.pathname === "/api/invites/revoke") {
        const member = authenticate(store, request);
        const input = await body(request);
        store.revokeInvite(member, member.team_id, string(input.inviteId, "invite ID"));
        return json(response, 200, { ok: true });
      }
      if (request.method === "GET" && url.pathname === "/api/invites") {
        const member = authenticate(store, request);
        return json(response, 200, store.listInvites(member));
      }
      if (request.method === "POST" && url.pathname === "/api/members/remove") {
        const member = authenticate(store, request);
        const input = await body(request);
        const memberId = string(input.memberId, "member ID");
        store.removeMember(member, member.team_id, memberId);
        for (const connection of connections) {
          if (connection.member.id === memberId) {
            connections.delete(connection);
            connection.socket.close(4003, "Membership revoked");
          }
        }
        broadcast(member.team_id);
        return json(response, 200, { ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/tasks/decide") {
        const member = authenticate(store, request);
        const input = await body(request);
        if (input.decision !== "accepted" && input.decision !== "dismissed") {
          throw new HubError("Invalid decision", 400);
        }
        store.decideTask(member, string(input.taskId, "task ID"), input.decision);
        broadcast(member.team_id);
        return json(response, 200, { ok: true });
      }
      return json(response, 404, { error: "Not found" });
    } catch (error) {
      if (error instanceof HubError) return json(response, error.status, { error: error.message });
      console.error("Hub request failed", error);
      return json(response, 500, { error: "Internal error" });
    }
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://hub.local");
    if (url.pathname !== "/ws") return rejectUpgrade(socket, 404, "Not found");
    if (url.searchParams.get("version") !== String(TEAM_HUB_PROTOCOL_VERSION)) {
      return rejectUpgrade(socket, 426, `Hub protocol ${TEAM_HUB_PROTOCOL_VERSION} required`);
    }
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (!alive.has(client)) {
        client.terminate();
        continue;
      }
      alive.delete(client);
      client.ping();
    }
  }, options.heartbeatMs ?? 25_000);

  wss.on("connection", (socket) => {
    alive.add(socket);
    socket.on("pong", () => alive.add(socket));
    let connection: Connected | null = null;
    const authDeadline = setTimeout(() => socket.close(4001, "Authentication required"), 10_000);
    socket.on("message", (data) => {
      try {
        const parsed: unknown = JSON.parse(data.toString());
        if (!connection) {
          if (
            !parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            (parsed as Record<string, unknown>).type !== "hello" ||
            typeof (parsed as Record<string, unknown>).credential !== "string"
          ) {
            throw new HubError("Authentication required", 401);
          }
          const credential = (parsed as { credential: string }).credential;
          const member = store.authenticate(credential);
          clearTimeout(authDeadline);
          connection = { socket, member, credential };
          connections.add(connection);
          broadcast(member.team_id);
          return;
        }
        // A removed member's already-open socket must lose write access immediately.
        store.authenticate(connection.credential);
        const message = decodeClientMessage(parsed);
        store.publish(connection.member, message);
        broadcast(connection.member.team_id);
      } catch (error) {
        if (error instanceof HubError && error.status === 401) {
          socket.close(4003, "Membership revoked or invalid");
          return;
        }
        socket.send(
          JSON.stringify({
            type: "error",
            message: error instanceof HubError ? error.message : "Invalid message",
          }),
        );
      }
    });
    socket.on("close", () => {
      clearTimeout(authDeadline);
      if (connection) {
        connections.delete(connection);
        broadcast(connection.member.team_id);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Hub did not bind a TCP port");
  return {
    port: address.port,
    close: async () => {
      clearInterval(heartbeat);
      for (const connection of connections) connection.socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      wss.close();
    },
  };
}
