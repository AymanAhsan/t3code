import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import {
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as TeamHubService from "./TeamHubService.ts";

export const teamHubHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "teamHub",
  Effect.fnUntraced(function* (handlers) {
    const hub = yield* TeamHubService.TeamHubService;
    const state = hub.state;
    return handlers
      .handle(
        "state",
        Effect.fn("teamHub.state")(function* () {
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* state;
        }),
      )
      .handle(
        "join",
        Effect.fn("teamHub.join")(function* ({ payload }) {
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          yield* hub
            .join(payload)
            .pipe(Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")));
          return yield* state;
        }),
      )
      .handle(
        "bootstrap",
        Effect.fn("teamHub.bootstrap")(function* ({ payload }) {
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          yield* hub
            .bootstrap(payload)
            .pipe(Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")));
          return yield* state;
        }),
      )
      .handle(
        "leave",
        Effect.fn("teamHub.leave")(function* () {
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          yield* hub.leave.pipe(
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          );
          return yield* state;
        }),
      )
      .handle(
        "publish",
        Effect.fn("teamHub.publish")(function* ({ payload }) {
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          yield* hub
            .publish(payload)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
          return yield* state;
        }),
      )
      .handle(
        "invite",
        Effect.fn("teamHub.invite")(function* () {
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          return yield* hub.createInvite.pipe(
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          );
        }),
      )
      .handle(
        "invites",
        Effect.fn("teamHub.invites")(function* () {
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          return yield* hub.listInvites.pipe(
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          );
        }),
      )
      .handle(
        "revokeInvite",
        Effect.fn("teamHub.revokeInvite")(function* ({ payload }) {
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          yield* hub
            .revokeInvite(payload.inviteId)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
          return yield* state;
        }),
      )
      .handle(
        "removeMember",
        Effect.fn("teamHub.removeMember")(function* ({ payload }) {
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          yield* hub
            .removeMember(payload.memberId)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
          return yield* state;
        }),
      )
      .handle(
        "decideTask",
        Effect.fn("teamHub.decideTask")(function* ({ payload }) {
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          yield* hub
            .decideTask(payload.taskId, payload.decision)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
          return yield* state;
        }),
      );
  }),
);
