import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  type TeamHubTask,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as TeamHubDelegationService from "../../../teamHub/TeamHubDelegationService.ts";
import * as TeamHubService from "../../../teamHub/TeamHubService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { TeamHubHandlersLive } from "./handlers.ts";
import { TeamHubToolkit } from "./tools.ts";

const selfId = "00000000-0000-0000-0000-000000000001";
const teammateId = "00000000-0000-0000-0000-000000000002";
const invokeInbox = (
  canonicalKey: string | null,
  missingProject = false,
  tasks: ReadonlyArray<TeamHubTask> = [],
) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("notes-api");
    const threadId = ThreadId.make("bob");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const dependencies = Layer.mergeAll(
      Layer.mock(TeamHubDelegationService.TeamHubDelegationService)({}),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        threadId,
        providerSessionId: "session",
        providerInstanceId,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed({
            id: threadId,
            projectId,
            deletedAt: null,
          } as OrchestrationV2ThreadShell),
      }),
      Layer.mock(ProjectService.ProjectService)({
        getShell: (_id, options) =>
          Effect.succeed(
            missingProject
              ? Option.none()
              : Option.some({
                  id: projectId,
                  workspaceRoot: "/work/notes-api",
                  repositoryIdentity:
                    options?.resolveRepositoryIdentity && canonicalKey ? { canonicalKey } : null,
                } as OrchestrationProjectShell),
          ),
      }),
      Layer.mock(TeamHubService.TeamHubService)({
        state: Effect.succeed({
          status: "connected",
          url: "http://localhost:8080",
          error: null,
          snapshot: {
            team: { id: "team", name: "Team", repo: "https://github.com/AymanAhsan/notes-api.git" },
            selfId,
            members: [],
            summaries: [],
            notes: [],
            tasks,
            claims: [],
            contractChanges: [],
          },
        }),
      }),
    );
    const toolkit = yield* TeamHubToolkit.pipe(
      Effect.provide(TeamHubHandlersLive.pipe(Layer.provide(dependencies))),
    );
    const results = yield* toolkit
      .handle("team_inbox", {})
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    return results.at(-1)?.result;
  });

it.effect("allows the matching repository after resolving missing metadata", () =>
  Effect.gen(function* () {
    expect(yield* invokeInbox("github.com/aymanahsan/notes-api")).toEqual({
      members: [],
      summaries: [],
      notes: [],
      tasks: [],
    });
  }),
);

it.effect("denies a genuinely different repository", () =>
  Effect.gen(function* () {
    expect(yield* invokeInbox("github.com/aymanahsan/other-repo")).toMatchObject({
      code: "capability_denied",
      message: "The calling project does not match the team repository.",
    });
  }),
);

it.effect("reports unavailable Git identity separately from a repository mismatch", () =>
  Effect.gen(function* () {
    expect(yield* invokeInbox(null)).toMatchObject({ code: "provider_unavailable" });
  }),
);

it.effect("denies a missing project", () =>
  Effect.gen(function* () {
    expect(yield* invokeInbox(null, true)).toMatchObject({ code: "capability_denied" });
  }),
);

it.effect("keeps authored completions and accepted work visible in the inbox", () =>
  Effect.gen(function* () {
    const completed: TeamHubTask = {
      id: "00000000-0000-0000-0000-000000000003",
      authorId: selfId,
      assigneeId: teammateId,
      text: "Build API",
      status: "done",
      threadId: ThreadId.make("accepted-thread"),
      result: { branch: "work/api", sha: "a".repeat(40), description: "API ready; tests passed" },
      contract: null,
      contractAwaiting: null,
      createdAt: 1,
    };
    const accepted = {
      ...completed,
      id: "00000000-0000-0000-0000-000000000004",
      status: "accepted" as const,
      authorId: teammateId,
      assigneeId: selfId,
      result: null,
    };
    const unrelated = {
      ...completed,
      id: "00000000-0000-0000-0000-000000000005",
      authorId: teammateId,
    };
    expect(
      yield* invokeInbox("github.com/aymanahsan/notes-api", false, [
        completed,
        accepted,
        unrelated,
      ]),
    ).toMatchObject({ tasks: [completed, accepted] });
  }),
);
