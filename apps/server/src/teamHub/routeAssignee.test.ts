import type { TeamHubMember } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { matchesDomain, routeAssignee } from "./routeAssignee.ts";

const member = (id: string, domains: string[]): TeamHubMember => ({
  id,
  name: id,
  role: "member",
  online: true,
  domains,
});

describe("matchesDomain", () => {
  it("matches nested paths, single segments, and directory prefixes", () => {
    expect(matchesDomain("apps/api/src/auth.ts", "apps/api/**")).toBe(true);
    expect(matchesDomain("apps/api", "apps/api/**")).toBe(false);
    expect(matchesDomain("api/auth.openapi.yaml", "**/*.openapi.yaml")).toBe(true);
    expect(matchesDomain("auth.openapi.yaml", "**/*.openapi.yaml")).toBe(true);
    expect(matchesDomain("apps/web/src/login.tsx", "apps/*/src/*.tsx")).toBe(true);
    expect(matchesDomain("apps/web/src/deep/login.tsx", "apps/*/src/*.tsx")).toBe(false);
    expect(matchesDomain("./server/routes.ts", "server/")).toBe(true);
    expect(matchesDomain("serverless/x.ts", "server/")).toBe(false);
  });
});

describe("routeAssignee", () => {
  const alice = member("alice", ["apps/web/**", "api/**"]);
  const bob = member("bob", ["api/**", "apps/api/**"]);
  const carol = member("carol", ["apps/api/**"]);

  it("routes to the only teammate who owns the paths, never the caller", () => {
    expect(routeAssignee([alice, bob], "alice", ["api/auth.yaml"]).assigneeId).toBe("bob");
  });

  it("returns candidates instead of guessing when ownership is ambiguous", () => {
    const result = routeAssignee([alice, bob, carol], "alice", ["apps/api/login.ts"]);
    expect(result.assigneeId).toBeNull();
    expect(result.candidates.map((candidate) => candidate.id)).toEqual(["bob", "carol"]);
  });

  it("returns nobody when no teammate owns every path", () => {
    expect(routeAssignee([alice, bob, carol], "alice", ["apps/api/a.ts", "docs/x.md"])).toEqual({
      assigneeId: null,
      candidates: [],
    });
  });
});
