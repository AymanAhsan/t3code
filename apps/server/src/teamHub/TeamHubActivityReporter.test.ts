import { ProviderDriverKind, ProviderInstanceId, RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { resolveTeamHubActivity } from "./TeamHubActivityReporter.ts";

const thread = (instance: string, requestedAt: string | null, running = false) => ({
  providerInstanceId: ProviderInstanceId.make(instance),
  activeRunId: running ? RunId.make(`run-${instance}`) : null,
  latestRunRequestedAt: requestedAt === null ? null : DateTime.makeUnsafe(requestedAt),
});
const driverOf = (id: string) => ProviderDriverKind.make(id === "work-claude" ? "claudeAgent" : id);

describe("resolveTeamHubActivity", () => {
  it("reports the most recently run agent while idle", () => {
    expect(
      resolveTeamHubActivity(
        [
          thread("codex", "2026-10-30T10:00:00Z"),
          thread("work-claude", "2026-10-30T11:00:00Z"),
          thread("cursor", null),
        ],
        driverOf,
      ),
    ).toEqual({ provider: "claudeAgent", working: false });
  });

  it("prefers a running agent over a newer idle one", () => {
    expect(
      resolveTeamHubActivity(
        [
          thread("codex", "2026-10-30T10:00:00Z", true),
          thread("work-claude", "2026-10-30T11:00:00Z"),
        ],
        driverOf,
      ),
    ).toEqual({ provider: "codex", working: true });
  });

  it("reports no agent before anything has run", () => {
    expect(resolveTeamHubActivity([thread("codex", null)], driverOf)).toEqual({
      provider: null,
      working: false,
    });
  });
});
