import type {
  TeamHubCheckInput,
  TeamHubClientMessage,
  TeamHubJoinInput,
  TeamHubBootstrapInput,
  TeamHubContractRef,
  TeamHubNetworkInput,
  TeamHubSnapshot,
} from "@t3tools/contracts/teamHub";
import * as Effect from "effect/Effect";
import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { makeEnvironmentHttpApiUrlBuilder } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

/** Uses the environment's existing RPC session, including reconnection. */
export function createTeamHubStateAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:team-hub",
    tag: WS_METHODS.subscribeTeamHubState,
  });
}

/** Tasks this environment's member can accept, oldest first. */
export function incomingTeamHubTasks(snapshot: TeamHubSnapshot | null) {
  return (
    snapshot?.tasks.filter(
      (task) =>
        task.status === "suggested" &&
        (task.assigneeId === null || task.assigneeId === snapshot.selfId),
    ) ?? []
  ).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** Turns the comma- or newline-separated "Your areas" text into domain globs. */
export function parseTeamHubDomains(text: string): string[] {
  const domains = text
    .split(/[\n,]/)
    .map((domain) => domain.trim())
    .filter((domain) => domain.length > 0 && domain.length <= 256);
  return [...new Set(domains)].slice(0, 20);
}

/** Short label for a task's contract, such as `api/auth.yaml @ 1a2b3c4 (contract/login)`. */
export function formatTeamHubContract(contract: TeamHubContractRef): string {
  return `${contract.path} @ ${contract.sha.slice(0, 7)} (${contract.branch})`;
}

export type TeamHubAction =
  | { readonly type: "join"; readonly input: TeamHubJoinInput }
  | { readonly type: "bootstrap"; readonly input: TeamHubBootstrapInput }
  | { readonly type: "exposeHub"; readonly input: TeamHubNetworkInput }
  | { readonly type: "unexposeHub"; readonly input: TeamHubNetworkInput }
  | { readonly type: "checkHub"; readonly input: TeamHubCheckInput }
  | { readonly type: "leave" }
  | { readonly type: "publish"; readonly input: TeamHubClientMessage }
  | { readonly type: "invite" }
  | { readonly type: "revokeInvite"; readonly inviteId: string }
  | { readonly type: "updateRepo"; readonly repo: string }
  | { readonly type: "removeMember"; readonly memberId: string }
  | {
      readonly type: "decideTask";
      readonly taskId: string;
      readonly decision: "accepted" | "dismissed";
    };

export function teamHubActionErrorMessage(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "_tag" in error &&
    error._tag === "EnvironmentRequestInvalidError" &&
    "reason" in error &&
    error.reason === "team_hub_project_missing"
  ) {
    return "Clone the team repo and add it as a project to accept tasks.";
  }
  return error instanceof Error ? error.message : "The team hub request failed.";
}

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

/**
 * Re-points a pasted hub link at another address, keeping its one-time token.
 * Setup links print `localhost` when the hub is shared over Tailscale, and the
 * token does not depend on the host.
 */
export function withTeamHubOrigin(
  link: { readonly url: string; readonly token: string },
  origin: string,
): { url: string; token: string } | null {
  try {
    const next = new URL(origin);
    return next.protocol === "https:" || next.protocol === "http:"
      ? { url: next.origin, token: link.token }
      : null;
  } catch {
    return null;
  }
}

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

export const readTeamHubNetworkState = Effect.fn("clientRuntime.teamHub.readNetworkState")(
  function* (prepared: PreparedConnection, input: TeamHubNetworkInput) {
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    );
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared,
      signer,
      remoteAuthorization,
      group: "teamHub",
      method: "POST",
      url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.networkState(),
      // The server waits on the Tailscale CLI and two probes.
      timeoutMs: 15_000,
      request: ({ client, headers }) => client.networkState({ headers, payload: input }),
    });
  },
);

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
    case "exposeHub":
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...common,
        // Sharing waits for Tailscale to issue the HTTPS certificate.
        timeoutMs: 45_000,
        url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.exposeHub(),
        request: ({ client, headers }) => client.exposeHub({ headers, payload: action.input }),
      });
    case "unexposeHub":
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...common,
        timeoutMs: 20_000,
        url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.unexposeHub(),
        request: ({ client, headers }) => client.unexposeHub({ headers, payload: action.input }),
      });
    case "checkHub":
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...common,
        timeoutMs: 15_000,
        url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.checkHub(),
        request: ({ client, headers }) => client.checkHub({ headers, payload: action.input }),
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
    case "updateRepo":
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...common,
        url: (base) => makeEnvironmentHttpApiUrlBuilder(base).teamHub.updateRepo(),
        request: ({ client, headers }) =>
          client.updateRepo({ headers, payload: { repo: action.repo } }),
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
