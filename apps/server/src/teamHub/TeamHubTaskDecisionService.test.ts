import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type TeamHubSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TeamHubService from "./TeamHubService.ts";
import { TeamHubTaskDecisionService, layer, taskPrompt } from "./TeamHubTaskDecisionService.ts";

const taskId = "00000000-0000-0000-0000-000000000001";
const authorId = "00000000-0000-0000-0000-000000000002";
const selfId = "00000000-0000-0000-0000-000000000003";
const projectId = ProjectId.make("project:team-hub-task");
const threadId = ThreadId.make("thread:team-hub-task");
const project: OrchestrationProjectShell = {
  id: projectId,
  title: "Team repo",
  workspaceRoot: "/team-repo",
  repositoryIdentity: {
    canonicalKey: "github.com/example/repo",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:example/repo.git",
    },
  },
  defaultModelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-6.1-sol",
  },
  scripts: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const snapshot: TeamHubSnapshot = {
  team: {
    id: "00000000-0000-0000-0000-000000000004",
    name: "Engineering",
    repo: "https://github.com/example/repo.git",
  },
  selfId,
  members: [
    { id: authorId, name: "Bob", role: "member", online: true, domains: [] },
    { id: selfId, name: "Alice", role: "member", online: true, domains: [] },
  ],
  summaries: [],
  tasks: [
    {
      id: taskId,
      authorId,
      assigneeId: selfId,
      text: "Fix the search bug",
      status: "suggested",
      threadId: null,
      result: null,
      contract: null,
      contractAwaiting: null,
      createdAt: 1,
    },
  ],
  notes: [],
  claims: [],
  contractChanges: [],
};

function makeHarness(
  options: {
    matchingProject?: boolean;
    reserve?: boolean;
    hubRejects?: boolean;
    launchFails?: boolean;
    projects?: ReadonlyArray<OrchestrationProjectShell>;
    recentlyUsedProjectId?: ProjectId;
    snapshot?: TeamHubSnapshot;
  } = {},
) {
  const launched = new Map<ThreadId, { projectId: ProjectId; firstMessage: string }>();
  const hubDecisions: Array<"accepted" | "dismissed"> = [];
  const reservations: string[] = [];
  const released: string[] = [];
  const dependencies = Layer.mergeAll(
    Layer.mock(TeamHubService.TeamHubService)({
      stream: Stream.make({
        url: "http://localhost:3000",
        status: "connected" as const,
        snapshot: options.snapshot ?? snapshot,
        error: null,
      }),
      reserveAutoStart: (id) =>
        Effect.sync(() => {
          reservations.push(id);
          return { reserved: options.reserve !== false };
        }),
      releaseAutoStart: (id) =>
        Effect.sync(() => {
          released.push(id);
        }),
      state: Effect.succeed({
        url: "http://localhost:3000",
        status: "connected" as const,
        snapshot: options.snapshot ?? snapshot,
        error: null,
      }),
      decideTask: (_taskId, decision, acceptedThreadId) =>
        Effect.gen(function* () {
          if (options.hubRejects) {
            return yield* new TeamHubService.TeamHubError({
              reason: "Hub rejected task",
              cause: null,
            });
          }
          if (decision === "accepted") {
            expect(launched.has(threadId)).toBe(true);
            expect(acceptedThreadId).toBe(threadId);
          }
          hubDecisions.push(decision);
        }),
    }),
    Layer.mock(ProjectService.ProjectService)({
      listShells: () =>
        Effect.succeed(options.matchingProject === false ? [] : (options.projects ?? [project])),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getShellSnapshot: () =>
        Effect.succeed({
          threads: options.recentlyUsedProjectId
            ? [
                {
                  projectId: options.recentlyUsedProjectId,
                  updatedAt: DateTime.makeUnsafe("2026-10-04T00:00:00.000Z"),
                },
              ]
            : [],
        } as never),
      dispatch: (command) =>
        Effect.sync(() => {
          if (command.type === "thread.delete") launched.delete(command.threadId);
          return {} as never;
        }),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) =>
        options.launchFails
          ? Effect.fail(
              new ThreadLaunch.ThreadLaunchError({
                operation: "create-thread",
                commandId: input.commandId,
                projectId: input.projectId,
                cause: new Error("Cannot create thread"),
              }),
            )
          : Effect.sync(() => {
              launched.set(threadId, {
                projectId: input.projectId,
                firstMessage: input.initialMessage?.text ?? "",
              });
              return { threadId, projection: {} as never, resumed: false };
            }),
    }),
    ServerSettings.layerTest(),
    makeProviderRegistryLayer(),
    NodeCrypto.layer,
  );
  return {
    layer: layer.pipe(Layer.provideMerge(dependencies)),
    launched,
    hubDecisions,
    reservations,
    released,
  };
}

describe("team hub suggested task acceptance", () => {
  it.effect(
    "starts a thread with the task and teammate attribution before accepting on the hub",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const decisions = yield* TeamHubTaskDecisionService;
        const result = yield* decisions.decideTask(taskId, "accepted");
        expect(result.threadId).toBe(threadId);
        expect(harness.launched.get(threadId)).toEqual({
          projectId,
          firstMessage: taskPrompt(snapshot.tasks[0]!, "Bob"),
        });
        expect(harness.hubDecisions).toEqual(["accepted"]);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("leaves the task pending when the team repository has no local project", () => {
    const harness = makeHarness({ matchingProject: false });
    return Effect.gen(function* () {
      const decisions = yield* TeamHubTaskDecisionService;
      const error = yield* decisions.decideTask(taskId, "accepted").pipe(Effect.flip);
      expect(error.reason).toBe("project_missing");
      expect(harness.launched.size).toBe(0);
      expect(harness.hubDecisions).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("refuses to accept a revised contract the author has not agreed to", () => {
    const pending = {
      ...snapshot.tasks[0]!,
      contract: { branch: "contract/search", path: "api/search.yaml", sha: "c".repeat(40) },
      contractAwaiting: "author" as const,
    };
    const harness = makeHarness({ snapshot: { ...snapshot, tasks: [pending] } });
    return Effect.gen(function* () {
      const decisions = yield* TeamHubTaskDecisionService;
      const error = yield* decisions.decideTask(taskId, "accepted").pipe(Effect.flip);
      expect(error.reason).toBe("contract_pending");
      expect(harness.launched.size).toBe(0);
      expect(harness.hubDecisions).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("leaves the task pending when thread creation fails", () => {
    const harness = makeHarness({ launchFails: true });
    return Effect.gen(function* () {
      const decisions = yield* TeamHubTaskDecisionService;
      const error = yield* decisions.decideTask(taskId, "accepted").pipe(Effect.flip);
      expect(error.reason).toBe("thread_launch_failed");
      expect(harness.launched.size).toBe(0);
      expect(harness.hubDecisions).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("chooses the most recently used matching clone", () => {
    const recentProjectId = ProjectId.make("project:recent-team-clone");
    const harness = makeHarness({
      projects: [
        project,
        { ...project, id: recentProjectId, updatedAt: "2026-09-01T00:00:00.000Z" },
      ],
      recentlyUsedProjectId: recentProjectId,
    });
    return Effect.gen(function* () {
      const decisions = yield* TeamHubTaskDecisionService;
      yield* decisions.decideTask(taskId, "accepted");
      expect(harness.launched.get(threadId)?.projectId).toBe(recentProjectId);
      expect(harness.hubDecisions).toEqual(["accepted"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("removes the new thread when the hub rejects acceptance", () => {
    const harness = makeHarness({ hubRejects: true });
    return Effect.gen(function* () {
      const decisions = yield* TeamHubTaskDecisionService;
      const error = yield* decisions.decideTask(taskId, "accepted").pipe(Effect.flip);
      expect(error.reason).toBe("hub_failed");
      expect(harness.launched.size).toBe(0);
      expect(harness.hubDecisions).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("accepted task prompt", () => {
  it("points the agent at the pinned contract when the task has one", () => {
    const prompt = taskPrompt(
      {
        ...snapshot.tasks[0]!,
        text: "Build the login API",
        contract: { branch: "contract/login-api", path: "api/auth.yaml", sha: "b".repeat(40) },
      },
      "Alice",
    );
    expect(prompt).toContain("Build the login API\n\nSuggested by Alice.");
    expect(prompt).toContain(
      `Contract: api/auth.yaml on branch contract/login-api at ${"b".repeat(40)}.`,
    );
    expect(prompt).toContain("git fetch origin contract/login-api");
  });
});

describe("automatic task startup", () => {
  const automaticSnapshot: TeamHubSnapshot = {
    ...snapshot,
    members: snapshot.members.map((member) =>
      member.id === selfId
        ? {
            ...member,
            domains: ["api/**"],
            autoAccept: { trustedAuthorIds: [authorId], remainingStarts: 3 },
          }
        : member,
    ),
    tasks: [
      {
        ...snapshot.tasks[0]!,
        contract: { branch: "contract/search", path: "api/search.yaml", sha: "a".repeat(40) },
      },
    ],
  };

  it.effect(
    "starts eligible work through the normal launch path after reserving its allowance",
    () => {
      const harness = makeHarness({ snapshot: automaticSnapshot });
      return Effect.gen(function* () {
        const decisions = yield* TeamHubTaskDecisionService;
        yield* decisions.startAutomaticTasks;
        expect(harness.reservations).toEqual([taskId]);
        expect(harness.hubDecisions).toEqual(["accepted"]);
        expect(harness.launched.size).toBe(1);
        expect(harness.released).toEqual([taskId]);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("does not launch when the hub refuses the reservation", () => {
    const harness = makeHarness({ snapshot: automaticSnapshot, reserve: false });
    return Effect.gen(function* () {
      yield* (yield* TeamHubTaskDecisionService).startAutomaticTasks;
      expect(harness.reservations).toEqual([taskId]);
      expect(harness.hubDecisions).toEqual([]);
      expect(harness.launched.size).toBe(0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("releases failed launches for manual recovery without accepting the task", () => {
    const harness = makeHarness({ snapshot: automaticSnapshot, launchFails: true });
    return Effect.gen(function* () {
      yield* (yield* TeamHubTaskDecisionService).startAutomaticTasks;
      expect(harness.reservations).toEqual([taskId]);
      expect(harness.released).toEqual([taskId]);
      expect(harness.hubDecisions).toEqual([]);
      expect(harness.launched.size).toBe(0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("does not attempt tasks when automatic acceptance is off", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* (yield* TeamHubTaskDecisionService).startAutomaticTasks;
      expect(harness.reservations).toEqual([]);
      expect(harness.launched.size).toBe(0);
    }).pipe(Effect.provide(harness.layer));
  });
});
