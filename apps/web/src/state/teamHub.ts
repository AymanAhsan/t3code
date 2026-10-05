import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import { runTeamHubAction, type TeamHubAction } from "@t3tools/client-runtime/state/team-hub";

import { connectionAtomRuntime } from "~/connection/runtime";

/** Every team hub mutation the settings panels run against the connected environment. */
export const teamHubActionCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "team hub action",
  execute: ({ prepared, action }: { prepared: PreparedConnection; action: TeamHubAction }) =>
    runTeamHubAction(prepared, action),
});
