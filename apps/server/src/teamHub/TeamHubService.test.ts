// @effect-diagnostics nodeBuiltinImport:off - The test owns an isolated hub database and loopback server.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { createHubServer } from "../../../hub/src/server.ts";
import { HubStore } from "../../../hub/src/store.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { TeamHubService, layer } from "./TeamHubService.ts";

describe("local team hub connector", () => {
  it.effect("bootstraps through the local service, stores membership, and posts a note", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-local-team-hub-"));
        const store = new HubStore(dir);
        const server = yield* Effect.promise(() =>
          createHubServer(store, { host: "127.0.0.1", port: 0 }),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await server.close();
            store.close();
            NodeFS.rmSync(dir, { recursive: true, force: true });
          }),
        );
        const secrets = new Map<string, Uint8Array>();
        const secretLayer = Layer.succeed(
          ServerSecretStore.ServerSecretStore,
          ServerSecretStore.ServerSecretStore.of({
            get: (key) => Effect.sync(() => Option.fromUndefinedOr(secrets.get(key))),
            set: (key, value) =>
              Effect.sync(() => {
                secrets.set(key, value);
              }),
            remove: (key) =>
              Effect.sync(() => {
                secrets.delete(key);
              }),
            create: () => Effect.die("unused"),
            getOrCreateRandom: () => Effect.die("unused"),
          }),
        );
        yield* Effect.gen(function* () {
          const hub = yield* TeamHubService;
          yield* hub.bootstrap({
            url: `http://127.0.0.1:${server.port}`,
            token: store.setupToken!,
            teamName: "Engineering",
            repo: "github.com/example/repo",
            displayName: "Alice",
          });
          const credential = new TextDecoder().decode(secrets.get("team-hub-membership"));
          const member = store.authenticate(credential);
          yield* hub.publish({ type: "post_note", text: "Ready to pair" });
          expect(store.snapshot(member, new Set()).notes[0]?.text).toBe("Ready to pair");
          const invite = store.createInvite(member, store.snapshot(member, new Set()).team.id);
          const teammate = store.join(invite.token, "Bob");
          store.publish(store.authenticate(teammate.credential), {
            type: "claim_files",
            paths: ["src/api.ts"],
          });
          const conflict = yield* hub
            .publish({
              type: "claim_files",
              paths: ["src/api.ts"],
            })
            .pipe(Effect.flip);
          expect(conflict.message).toContain("File already claimed");
          yield* hub.leave;
          expect(secrets.has("team-hub-membership")).toBe(false);
        }).pipe(
          Effect.provide(
            layer.pipe(Layer.provide(ServerSettings.layerTest()), Layer.provide(secretLayer)),
          ),
        );
      }),
    ),
  );
});
