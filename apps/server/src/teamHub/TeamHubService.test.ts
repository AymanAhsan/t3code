// @effect-diagnostics nodeBuiltinImport:off - The test owns an isolated hub database and loopback server.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { TeamHubState } from "@t3tools/contracts/teamHub";
import { ThreadId } from "@t3tools/contracts";
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
          const updates = yield* Queue.unbounded<TeamHubState>();
          yield* hub.stream.pipe(
            Stream.runForEach((state) => Queue.offer(updates, state)),
            Effect.forkScoped,
          );
          expect(yield* Queue.take(updates)).toEqual({
            url: null,
            status: "disconnected",
            snapshot: null,
            error: null,
          });
          const nextState = (predicate: (state: TeamHubState) => boolean) =>
            Stream.fromQueue(updates).pipe(
              Stream.filter(predicate),
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            );
          yield* hub.bootstrap({
            url: `http://127.0.0.1:${server.port}`,
            token: store.setupToken!,
            teamName: "Engineering",
            repo: "github.com/example/repo",
            displayName: "Alice",
          });
          const credential = new TextDecoder().decode(secrets.get("team-hub-membership"));
          const member = store.authenticate(credential);
          const connected = yield* nextState((state) => state.status === "connected");
          expect(connected.snapshot?.selfId).toBe(member.id);
          yield* hub.publish({
            type: "post_task",
            assigneeId: member.id,
            text: "Review the API",
            contract: null,
          });
          const suggested = yield* nextState((state) => state.snapshot?.tasks.length === 1);
          const task = suggested.snapshot!.tasks[0]!;
          expect(task.text).toBe("Review the API");
          expect(task.status).toBe("suggested");
          // A reconnecting client receives the latest full state immediately.
          const resumed = yield* hub.stream.pipe(Stream.runHead);
          expect(Option.getOrThrow(resumed)).toEqual(suggested);
          yield* hub.decideTask(task.id, "dismissed");
          const dismissed = yield* nextState(
            (state) => state.snapshot?.tasks[0]?.status === "dismissed",
          );
          expect(dismissed.snapshot?.tasks[0]?.id).toBe(task.id);
          yield* hub.publish({
            type: "post_task",
            assigneeId: member.id,
            text: "Build API",
            contract: null,
          });
          const offered = yield* nextState(
            (state) => state.snapshot?.tasks.some((task) => task.text === "Build API") === true,
          );
          const workTask = offered.snapshot!.tasks.find((task) => task.text === "Build API")!;
          const threadId = ThreadId.make("delegated-thread");
          yield* hub.decideTask(workTask.id, "accepted", threadId);
          yield* nextState(
            (state) => state.snapshot?.tasks.some((task) => task.threadId === threadId) === true,
          );
          yield* hub.publishCheckpoint({
            threadId,
            repository: "github.com/example/repo",
            branch: "work/api",
            files: ["src/service.ts"],
            description: "API progress",
          });
          const progress = yield* nextState(
            (state) =>
              state.snapshot?.summaries.some((summary) => summary.taskId === workTask.id) === true,
          );
          expect(progress.snapshot?.tasks.find((task) => task.id === workTask.id)?.status).toBe(
            "accepted",
          );
          const result = {
            branch: "work/api",
            sha: "a".repeat(40),
            description: "API complete; tests passed",
          };
          yield* hub.publish({ type: "complete_task", taskId: workTask.id, result });
          const completed = yield* nextState(
            (state) => state.snapshot?.tasks.some((task) => task.status === "done") === true,
          );
          expect(completed.snapshot?.tasks.find((task) => task.id === workTask.id)?.result).toEqual(
            result,
          );
          yield* hub.publish({ type: "reopen_task", taskId: workTask.id });
          const reopened = yield* nextState(
            (state) =>
              state.snapshot?.tasks.some(
                (task) => task.id === workTask.id && task.status === "accepted",
              ) === true,
          );
          expect(
            reopened.snapshot?.tasks.find((task) => task.id === workTask.id)?.result,
          ).toBeNull();
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
          yield* hub.updateRepo("https://github.com/example/new-repo");
          const edited = yield* nextState(
            (state) => state.snapshot?.team.repo === "https://github.com/example/new-repo",
          );
          expect(edited.snapshot?.selfId).toBe(member.id);
          expect(edited.snapshot?.notes[0]?.text).toBe("Ready to pair");
          yield* hub.leave;
          expect(yield* nextState((state) => state.url === null)).toEqual({
            url: null,
            status: "disconnected",
            snapshot: null,
            error: null,
          });
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
