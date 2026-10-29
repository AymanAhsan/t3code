import { describe, expect, it } from "vite-plus/test";

import type { TeamHubSnapshot, TeamHubTask } from "@t3tools/contracts/teamHub";
import {
  formatTeamHubContract,
  incomingTeamHubTasks,
  parseTeamHubDomains,
  parseTeamHubLink,
  withTeamHubOrigin,
} from "./teamHub.ts";

describe("incomingTeamHubTasks", () => {
  const task = (id: string, overrides: Partial<TeamHubTask> = {}): TeamHubTask => ({
    id,
    authorId: "author",
    assigneeId: "self",
    text: "Review the change",
    status: "suggested",
    contract: null,
    contractAwaiting: null,
    createdAt: 10,
    ...overrides,
  });
  const snapshot = (tasks: TeamHubTask[]): TeamHubSnapshot => ({
    team: { id: "team", name: "Team", repo: "repo" },
    selfId: "self",
    members: [],
    summaries: [],
    tasks,
    notes: [],
    claims: [],
    contractChanges: [],
  });

  it("only shows pending tasks assigned to self or offered to everyone", () => {
    expect(
      incomingTeamHubTasks(
        snapshot([
          task("mine"),
          task("everyone", { assigneeId: null }),
          task("other", { assigneeId: "other" }),
          task("accepted", { status: "accepted" }),
          task("dismissed", { status: "dismissed" }),
        ]),
      ).map((task) => task.id),
    ).toEqual(["everyone", "mine"]);
  });

  it("keeps the oldest task first without mutating the snapshot", () => {
    const state = snapshot([task("new", { createdAt: 20 }), task("old")]);
    expect(incomingTeamHubTasks(state).map((task) => task.id)).toEqual(["old", "new"]);
    expect(state.tasks.map((task) => task.id)).toEqual(["new", "old"]);
  });

  it("puts a revised contract in front of the author and out of the assignee's way", () => {
    const contract = { branch: "contract/x", path: "api/x.yaml", sha: "a".repeat(40) };
    const state = snapshot([
      task("assigned-waiting", { contract, contractAwaiting: "author" }),
      task("authored-agree", {
        authorId: "self",
        assigneeId: "bob",
        contract,
        contractAwaiting: "author",
      }),
      task("authored-pending", {
        authorId: "self",
        assigneeId: "bob",
        contract,
        contractAwaiting: "assignee",
      }),
    ]);
    expect(incomingTeamHubTasks(state).map((task) => task.id)).toEqual(["authored-agree"]);
    expect(incomingTeamHubTasks(state, { includeWaiting: true }).map((task) => task.id)).toEqual([
      "assigned-waiting",
      "authored-agree",
    ]);
  });

  it("has no incoming tasks before joining a team", () => {
    expect(incomingTeamHubTasks(null)).toEqual([]);
  });
});

describe("withTeamHubOrigin", () => {
  it("re-points a setup link at the shared address and keeps its token", () => {
    const link = parseTeamHubLink("http://localhost:8080/setup#token=abc%2Bdef");
    expect(link).toEqual({ url: "http://localhost:8080", token: "abc+def" });
    expect(withTeamHubOrigin(link!, "https://desk.tail.ts.net/")).toEqual({
      url: "https://desk.tail.ts.net",
      token: "abc+def",
    });
  });

  it("drops any path or port detail down to the origin", () => {
    expect(
      withTeamHubOrigin(
        { url: "http://localhost:8080", token: "t" },
        "https://desk.tail.ts.net:8443/x?y=1",
      ),
    ).toEqual({ url: "https://desk.tail.ts.net:8443", token: "t" });
  });

  it("rejects an address that is not http or https", () => {
    expect(
      withTeamHubOrigin({ url: "http://localhost:8080", token: "t" }, "ftp://example.test"),
    ).toBeNull();
    expect(withTeamHubOrigin({ url: "http://localhost:8080", token: "t" }, "not a url")).toBeNull();
  });
});

describe("team hub domains and contracts", () => {
  it("splits areas on commas and newlines, dropping blanks and duplicates", () => {
    expect(parseTeamHubDomains(" apps/api/**, \n\napps/api/**\nserver/ ,")).toEqual([
      "apps/api/**",
      "server/",
    ]);
  });

  it("labels a contract by path, short sha, and branch", () => {
    const contract = {
      branch: "contract/login",
      path: "api/auth.yaml",
      sha: "1a2b3c4".padEnd(40, "0"),
    };
    expect(formatTeamHubContract(contract)).toBe("api/auth.yaml @ 1a2b3c4 (contract/login)");
  });
});
