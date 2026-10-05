import type {
  TeamHubClientMessage,
  TeamHubJoinInput,
  TeamHubBootstrapInput,
} from "@t3tools/contracts/teamHub";
import * as Effect from "effect/Effect";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { makeEnvironmentHttpApiUrlBuilder } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

export type TeamHubAction =
  | { readonly type: "join"; readonly input: TeamHubJoinInput }
  | { readonly type: "bootstrap"; readonly input: TeamHubBootstrapInput }
  | { readonly type: "leave" }
  | { readonly type: "publish"; readonly input: TeamHubClientMessage }
  | { readonly type: "invite" }
  | { readonly type: "revokeInvite"; readonly inviteId: string }
  | { readonly type: "removeMember"; readonly memberId: string }
  | {
      readonly type: "decideTask";
      readonly taskId: string;
      readonly decision: "accepted" | "dismissed";
    };

export function parseTeamHubLink(value: string): { url: string; token: string } | null {
  try {
    const link = new URL(value);
    const token = new URLSearchParams(link.hash.slice(1)).get("token");
    return (link.protocol === "https:" || link.protocol === "http:") && token
      ? { url: link.origin, token }
      : null;
  } catch {
    return null;
  }
}

export const readTeamHubState = Effect.fn("clientRuntime.teamHub.readState")(function* (
  prepared: PreparedConnection,
) {
  const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
  );
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    group: "teamHub",
    method: "GET",
    url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.state(),
    timeoutMs: 8_000,
    request: ({ client, headers }) => client.state({ headers }),
  });
});

export const readTeamHubInvites = Effect.fn("clientRuntime.teamHub.readInvites")(function* (
  prepared: PreparedConnection,
) {
  const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
  );
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    group: "teamHub",
    method: "GET",
    url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.invites(),
    timeoutMs: 8_000,
    request: ({ client, headers }) => client.invites({ headers }),
  });
});

export const runTeamHubAction = Effect.fn("clientRuntime.teamHub.action")(function* (
  prepared: PreparedConnection,
  action: TeamHubAction,
) {
  const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
  );
  const common = {
    prepared,
    signer,
    remoteAuthorization,
    group: "teamHub" as const,
    method: "POST" as const,
    timeoutMs: 8_000,
  };
  switch (action.type) {
    case "bootstrap":
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...common,
        url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.bootstrap(),
        request: ({ client, headers }) => client.bootstrap({ headers, payload: action.input }),
      });
    case "join":
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...common,
        url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.join(),
        request: ({ client, headers }) => client.join({ headers, payload: action.input }),
      });
    case "leave":
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...common,
        url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.leave(),
        request: ({ client, headers }) => client.leave({ headers }),
      });
    case "publish":
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...common,
        url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.publish(),
        // HttpApiClient exposes a union request as overloaded calls; the wire schema validates the union.
        request: ({ client, headers }) =>
          client.publish({ headers, payload: action.input as never }),
      });
    case "invite":
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...common,
        url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.invite(),
        request: ({ client, headers }) => client.invite({ headers }),
      });
    case "revokeInvite":
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...common,
        url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.revokeInvite(),
        request: ({ client, headers }) =>
          client.revokeInvite({ headers, payload: { inviteId: action.inviteId } }),
      });
    case "removeMember":
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...common,
        url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.removeMember(),
        request: ({ client, headers }) =>
          client.removeMember({ headers, payload: { memberId: action.memberId } }),
      });
    case "decideTask":
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...common,
        url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.decideTask(),
        request: ({ client, headers }) =>
          client.decideTask({
            headers,
            payload: { taskId: action.taskId, decision: action.decision },
          }),
      });
  }
});
