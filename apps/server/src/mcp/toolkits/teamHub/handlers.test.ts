import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
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

const invokeInbox = (canonicalKey: string | null, missingProject = false) =>
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
            selfId: "bob",
            members: [],
            summaries: [],
            notes: [],
            tasks: [],
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
