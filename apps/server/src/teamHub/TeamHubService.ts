// @effect-diagnostics globalFetchInEffect:off globalTimers:off preferSchemaOverJson:off - The hub connector owns the native WebSocket and its companion HTTP requests.
import type {
  TeamHubBootstrapInput,
  TeamHubClientMessage,
  TeamHubInviteRecord,
  TeamHubJoinInput,
  TeamHubState,
} from "@t3tools/contracts/teamHub";
import {
  TEAM_HUB_PROTOCOL_VERSION,
  TeamHubSnapshot as TeamHubSnapshotSchema,
} from "@t3tools/contracts/teamHub";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";

const CREDENTIAL_NAME = "team-hub-membership";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const decodeSnapshot = Schema.decodeUnknownSync(TeamHubSnapshotSchema);

export class TeamHubError extends Schema.TaggedError<TeamHubError>()("TeamHubError", {
  reason: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return this.reason;
  }
}

export class TeamHubService extends Context.Service<
  TeamHubService,
  {
    readonly state: Effect.Effect<TeamHubState>;
    readonly start: Effect.Effect<void, TeamHubError>;
    readonly stop: Effect.Effect<void>;
    readonly join: (input: {
      readonly url: string;
      readonly token: string;
      readonly displayName: string;
    }) => Effect.Effect<void, TeamHubError>;
    readonly bootstrap: (input: TeamHubBootstrapInput) => Effect.Effect<void, TeamHubError>;
    readonly leave: Effect.Effect<void, TeamHubError>;
    readonly publish: (message: TeamHubClientMessage) => Effect.Effect<void, TeamHubError>;
    readonly publishCheckpoint: (input: {
      readonly repository: string;
      readonly branch: string;
      readonly files: ReadonlyArray<string>;
      readonly description: string;
    }) => Effect.Effect<void>;
    readonly createInvite: Effect.Effect<
      { id: string; token: string; expiresAt: number },
      TeamHubError
    >;
    readonly listInvites: Effect.Effect<ReadonlyArray<TeamHubInviteRecord>, TeamHubError>;
    readonly revokeInvite: (inviteId: string) => Effect.Effect<void, TeamHubError>;
    readonly removeMember: (memberId: string) => Effect.Effect<void, TeamHubError>;
    readonly decideTask: (
      taskId: string,
      decision: "accepted" | "dismissed",
    ) => Effect.Effect<void, TeamHubError>;
  }
>()("t3/teamHub/TeamHubService") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  let state: TeamHubState = { url: null, status: "disconnected", snapshot: null, error: null };
  let credential: string | null = null;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const disconnect = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    socket?.close();
    socket = null;
    state = { ...state, status: "disconnected", snapshot: null };
  };

  const connect = () => {
    if (stopped || !state.url || !credential) return;
    disconnect();
    let url: URL;
    try {
      url = new URL("/ws", state.url);
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error("Invalid hub protocol");
    } catch {
      state = { ...state, error: "Invalid team hub address" };
      return;
    }
    url.searchParams.set("version", String(TEAM_HUB_PROTOCOL_VERSION));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const current = new WebSocket(url);
    socket = current;
    state = { ...state, status: "connecting", error: null };
    current.addEventListener("open", () => {
      if (socket !== current) return;
      current.send(JSON.stringify({ type: "hello", credential }));
    });
    current.addEventListener("message", (event) => {
      if (socket !== current) return;
      try {
        const message: unknown = JSON.parse(String(event.data));
        if (
          message &&
          typeof message === "object" &&
          "type" in message &&
          message.type === "snapshot" &&
          "snapshot" in message
        ) {
          state = {
            ...state,
            status: "connected",
            snapshot: decodeSnapshot(message.snapshot),
            error: null,
          };
        } else if (
          message &&
          typeof message === "object" &&
          "type" in message &&
          message.type === "error" &&
          "message" in message &&
          typeof message.message === "string"
        ) {
          state = { ...state, error: message.message };
        }
      } catch {
        state = { ...state, error: "Hub sent an invalid response" };
      }
    });
    current.addEventListener("close", (event) => {
      if (socket !== current) return;
      socket = null;
      state = {
        ...state,
        status: "disconnected",
        snapshot: null,
        error: event.code === 4003 ? "Membership revoked" : "Hub disconnected",
      };
      if (!stopped && event.code !== 4003) reconnectTimer = setTimeout(connect, 3000);
    });
    current.addEventListener("error", () => {
      if (socket === current) state = { ...state, error: "Cannot reach team hub" };
    });
  };

  const request = <A>(path: string, input?: unknown): Effect.Effect<A, TeamHubError> =>
    Effect.tryPromise({
      try: async () => {
        if (!state.url || !credential) throw new Error("Not joined to a team hub");
        const response = await fetch(new URL(path, state.url), {
          method: input === undefined ? "GET" : "POST",
          headers: {
            authorization: `Bearer ${credential}`,
            ...(input === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        });
        const result: unknown = await response.json();
        if (!response.ok) {
          throw new Error(
            typeof result === "object" &&
              result !== null &&
              "error" in result &&
              typeof result.error === "string"
              ? result.error
              : `Hub returned ${response.status}`,
          );
        }
        return result as A;
      },
      catch: (cause) =>
        new TeamHubError({
          reason: cause instanceof Error ? cause.message : "Team hub request failed",
          cause,
        }),
    });

  const start = Effect.gen(function* () {
    const currentSettings = yield* settings.getSettings.pipe(
      Effect.mapError(
        (cause) => new TeamHubError({ reason: "Cannot load team hub settings", cause }),
      ),
    );
    const saved = yield* secrets
      .get(CREDENTIAL_NAME)
      .pipe(
        Effect.mapError(
          (cause) => new TeamHubError({ reason: "Cannot load team membership", cause }),
        ),
      );
    state = { ...state, url: currentSettings.teamHubUrl };
    credential = Option.isSome(saved) ? decoder.decode(saved.value) : null;
    connect();
  });

  const enroll = (input: TeamHubJoinInput | TeamHubBootstrapInput) =>
    Effect.gen(function* () {
      const url = yield* Effect.try({
        try: () => {
          const parsed = new URL(input.url);
          if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
            throw new Error("Invalid scheme");
          parsed.pathname = "/";
          parsed.search = "";
          parsed.hash = "";
          return parsed;
        },
        catch: (cause) => new TeamHubError({ reason: "Invalid team hub address", cause }),
      });
      const result = yield* Effect.tryPromise({
        try: async () => {
          const response = await fetch(
            new URL("teamName" in input ? "/api/bootstrap" : "/api/join", url),
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(input),
            },
          );
          const data: unknown = await response.json();
          if (
            !response.ok ||
            !data ||
            typeof data !== "object" ||
            !("credential" in data) ||
            typeof data.credential !== "string"
          )
            throw new Error("Team hub enrollment was rejected");
          return data.credential;
        },
        catch: (cause) => new TeamHubError({ reason: "Could not join team hub", cause }),
      });
      yield* secrets
        .set(CREDENTIAL_NAME, encoder.encode(result))
        .pipe(
          Effect.mapError(
            (cause) => new TeamHubError({ reason: "Cannot save team membership", cause }),
          ),
        );
      yield* settings
        .updateSettings({ teamHubUrl: url.toString() })
        .pipe(
          Effect.mapError(
            (cause) => new TeamHubError({ reason: "Cannot save team hub address", cause }),
          ),
        );
      credential = result;
      state = { url: url.toString(), status: "disconnected", snapshot: null, error: null };
      connect();
    });

  const leave = Effect.gen(function* () {
    disconnect();
    credential = null;
    yield* secrets
      .remove(CREDENTIAL_NAME)
      .pipe(
        Effect.mapError(
          (cause) => new TeamHubError({ reason: "Cannot remove team membership", cause }),
        ),
      );
    yield* settings
      .updateSettings({ teamHubUrl: null })
      .pipe(
        Effect.mapError(
          (cause) => new TeamHubError({ reason: "Cannot clear team hub address", cause }),
        ),
      );
    state = { url: null, status: "disconnected", snapshot: null, error: null };
  });

  return TeamHubService.of({
    state: Effect.sync(() => state),
    start,
    stop: Effect.sync(() => {
      stopped = true;
      disconnect();
    }),
    join: enroll,
    bootstrap: enroll,
    leave,
    publish: (message) => request("/api/publish", message),
    publishCheckpoint: (input) =>
      Effect.sync(() => {
        if (
          !socket ||
          socket.readyState !== WebSocket.OPEN ||
          !state.snapshot ||
          normalizeGitRemoteUrl(state.snapshot.team.repo) !== input.repository
        )
          return;
        const files = input.files.filter((path) => path.length <= 256).slice(0, 200);
        socket.send(
          JSON.stringify({
            type: "publish_summary",
            branch: input.branch.slice(0, 256),
            files,
            description: input.description.slice(0, 1000),
          } satisfies TeamHubClientMessage),
        );
        const contractPaths = files.filter((path) =>
          /(?:^|\/)(?:contracts?|schemas?|routes?|api)(?:\/|\.)|\.(?:graphql|proto)$/i.test(path),
        );
        if (contractPaths.length > 0) {
          socket.send(
            JSON.stringify({
              type: "post_contract_change",
              description: `Changed ${contractPaths.length} interface file${contractPaths.length === 1 ? "" : "s"}`,
              paths: contractPaths.slice(0, 50),
            } satisfies TeamHubClientMessage),
          );
        }
      }),
    createInvite: request("/api/invites", {}),
    listInvites: request("/api/invites"),
    revokeInvite: (inviteId) => request("/api/invites/revoke", { inviteId }),
    removeMember: (memberId) => request("/api/members/remove", { memberId }),
    decideTask: (taskId, decision) => request("/api/tasks/decide", { taskId, decision }),
  });
});

export const layer = Layer.effect(
  TeamHubService,
  Effect.gen(function* () {
    const service = yield* make;
    yield* service.start;
    yield* Effect.addFinalizer(() => service.stop);
    return service;
  }),
);
