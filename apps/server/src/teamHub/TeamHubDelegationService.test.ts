import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type TeamHubClientMessage,
  type TeamHubContractRef,
  type TeamHubMember,
  type TeamHubSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { TeamHubDelegationService, layer } from "./TeamHubDelegationService.ts";
import * as TeamHubService from "./TeamHubService.ts";

const projectId = ProjectId.make("project:team-hub-delegation");
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
  defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
  scripts: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const member = (id: string, name: string, domains: string[]): TeamHubMember => ({
  id,
  name,
  role: "member",
  online: true,
  domains,
});
const alice = member("alice", "Alice", ["apps/web/**"]);
const bob = member("bob", "Bob", ["api/**"]);

const contract: TeamHubContractRef = {
  branch: "contract/login-api",
  path: "api/auth.yaml",
  sha: "b".repeat(40),
};

function makeHarness(
  options: {
    members?: TeamHubMember[];
    fetchFails?: boolean;
    notAncestor?: boolean;
    accepted?: boolean;
  } = {},
) {
  const published: TeamHubClientMessage[] = [];
  const gitCalls: string[][] = [];
  const snapshot: TeamHubSnapshot = {
    team: { id: "team", name: "Engineering", repo: "https://github.com/example/repo.git" },
    selfId: alice.id,
    members: options.members ?? [alice, bob],
    summaries: [],
    tasks: [
      {
        id: "task",
        authorId: bob.id,
        assigneeId: alice.id,
        text: "Build the login page",
        status: options.accepted ? "accepted" : "suggested",
        threadId: options.accepted ? ThreadId.make("accepted-thread") : null,
        result: null,
        contract,
        contractAwaiting: "assignee",
        createdAt: 1,
      },
    ],
    notes: [],
    claims: [],
    contractChanges: [],
  };
  const dependencies = Layer.mergeAll(
    Layer.mock(TeamHubService.TeamHubService)({
      state: Effect.succeed({
        url: "http://localhost:3000",
        status: "connected" as const,
        snapshot,
        error: null,
      }),
      publish: (message) => Effect.sync(() => void published.push(message)),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getShell: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
    }),
    Layer.mock(GitVcsDriver.GitVcsDriver)({
      resolvePrimaryRemoteName: () => Effect.succeed("origin"),
      execute: ({ args }) =>
        Effect.sync(() => {
          gitCalls.push([...args]);
          const failed =
            (args[0] === "fetch" && options.fetchFails) ||
            (args[0] === "merge-base" && options.notAncestor);
          return { exitCode: failed ? 1 : 0, stdout: "", stderr: "" } as never;
        }),
    }),
  );
  return { layer: layer.pipe(Layer.provide(dependencies)), published, gitCalls };
}

const post = (input: { assigneeId?: string | null; contract?: TeamHubContractRef | null }) =>
  Effect.gen(function* () {
    const delegation = yield* TeamHubDelegationService;
    return yield* delegation.postTask({
      projectId,
      text: "Build the login API",
      assigneeId: input.assigneeId ?? null,
      contract: input.contract ?? null,
    });
  });

describe("TeamHubDelegationService", () => {
  const result = {
    branch: "work/login-api",
    sha: "d".repeat(40),
    description: "Built login API; tests passed",
  };
  const complete = (threadId = ThreadId.make("accepted-thread")) =>
    Effect.gen(function* () {
      const delegation = yield* TeamHubDelegationService;
      yield* delegation.completeTask({ projectId, threadId, taskId: "task", result });
    });

  it.effect(
    "completes the accepted task's thread only after verifying the result is pushed",
    () => {
      const harness = makeHarness({ accepted: true });
      return Effect.gen(function* () {
        yield* complete();
        expect(harness.gitCalls).toEqual([
          ["fetch", "--quiet", "--no-tags", "origin", "refs/heads/work/login-api"],
          ["merge-base", "--is-ancestor", result.sha, "FETCH_HEAD"],
        ]);
        expect(harness.published).toEqual([{ type: "complete_task", taskId: "task", result }]);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("refuses unpushed results without marking the task done", () => {
    const harness = makeHarness({ accepted: true, notAncestor: true });
    return Effect.gen(function* () {
      expect((yield* Effect.flip(complete())).reason).toBe("result_not_pushed");
      expect(harness.published).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("refuses completion from another thread", () => {
    const harness = makeHarness({ accepted: true });
    return Effect.gen(function* () {
      expect((yield* Effect.flip(complete(ThreadId.make("unrelated-thread")))).reason).toBe(
        "completion_unavailable",
      );
      expect(harness.gitCalls).toEqual([]);
      expect(harness.published).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("refuses completion before acceptance", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      expect((yield* Effect.flip(complete())).reason).toBe("completion_unavailable");
      expect(harness.published).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("routes a contract task to the owner after confirming the commit is pushed", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const result = yield* post({ contract });
      expect(result.assigneeId).toBe("bob");
      expect(harness.gitCalls).toEqual([
        ["fetch", "--quiet", "--no-tags", "origin", "refs/heads/contract/login-api"],
        ["merge-base", "--is-ancestor", contract.sha, "FETCH_HEAD"],
      ]);
      expect(harness.published).toEqual([
        { type: "post_task", text: "Build the login API", assigneeId: "bob", contract },
      ]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("refuses an unpushed contract without posting", () => {
    const harness = makeHarness({ notAncestor: true });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(post({ contract }));
      expect(error.reason).toBe("contract_not_pushed");
      expect(harness.published).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("treats a missing remote contract branch as unpushed", () => {
    const harness = makeHarness({ fetchFails: true });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(post({ contract }));
      expect(error.reason).toBe("contract_not_pushed");
      expect(harness.gitCalls).toHaveLength(1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("names the candidates when several teammates own the contract", () => {
    const carol = member("carol", "Carol", ["api/*.yaml"]);
    const harness = makeHarness({ members: [alice, bob, carol] });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(post({ contract }));
      expect(error.reason).toBe("ambiguous_assignee");
      expect(error.candidates).toEqual(["Bob (bob)", "Carol (carol)"]);
      expect(harness.gitCalls).toEqual([]);
      expect(harness.published).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("asks for an assignee when nobody owns the contract", () => {
    const harness = makeHarness({ members: [alice] });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(post({ contract }));
      expect(error.reason).toBe("no_assignee");
      expect(error.message).toContain("api/auth.yaml");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps an explicit assignee and still checks the contract is pushed", () => {
    const harness = makeHarness({ members: [alice] });
    return Effect.gen(function* () {
      const result = yield* post({ assigneeId: "dana", contract });
      expect(result.assigneeId).toBe("dana");
      expect(harness.gitCalls).toHaveLength(2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("posts a plain task without touching git", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const result = yield* post({});
      expect(result.assigneeId).toBeNull();
      expect(harness.gitCalls).toEqual([]);
      expect(harness.published).toHaveLength(1);
    }).pipe(Effect.provide(harness.layer));
  });

  const review = (input: { taskId?: string; decision: "agree" | "revise"; sha: string }) =>
    Effect.gen(function* () {
      const delegation = yield* TeamHubDelegationService;
      return yield* delegation.reviewContract({
        projectId,
        taskId: input.taskId ?? "task",
        decision: input.decision,
        sha: input.sha,
      });
    });

  it.effect("revises a contract only after the new commit is on the contract branch", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const revised = "c".repeat(40);
      yield* review({ decision: "revise", sha: revised });
      expect(harness.gitCalls[1]).toEqual(["merge-base", "--is-ancestor", revised, "FETCH_HEAD"]);
      expect(harness.published).toEqual([
        { type: "revise_contract", taskId: "task", sha: revised },
      ]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("refuses an unpushed revision without publishing", () => {
    const harness = makeHarness({ notAncestor: true });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(review({ decision: "revise", sha: "c".repeat(40) }));
      expect(error.reason).toBe("contract_not_pushed");
      expect(harness.published).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("agrees without touching git and rejects unknown tasks", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* review({ decision: "agree", sha: contract.sha });
      expect(harness.gitCalls).toEqual([]);
      expect(harness.published).toEqual([
        { type: "agree_contract", taskId: "task", sha: contract.sha },
      ]);
      const error = yield* Effect.flip(
        review({ taskId: "missing", decision: "agree", sha: contract.sha }),
      );
      expect(error.reason).toBe("task_unavailable");
    }).pipe(Effect.provide(harness.layer));
  });
});
