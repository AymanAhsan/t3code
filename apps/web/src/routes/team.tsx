import { createFileRoute } from "@tanstack/react-router";

import { TeamHubPage } from "../components/team/TeamHubPage";
import type { TeamHubMode } from "../components/team/teamHubRoute";

type TeamSearch = { mode?: TeamHubMode };

function TeamRoute() {
  const { mode } = Route.useSearch();
  return <TeamHubPage mode={mode ?? "join"} />;
}

export const Route = createFileRoute("/team")({
  validateSearch: (raw: Record<string, unknown>): TeamSearch =>
    raw.mode === "setup" || raw.mode === "join" ? { mode: raw.mode } : {},
  component: TeamRoute,
});
