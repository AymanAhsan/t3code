import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import {
  createTeamHubStateAtomFamily,
  runTeamHubAction,
  type TeamHubAction,
} from "@t3tools/client-runtime/state/team-hub";

import { connectionAtomRuntime } from "~/connection/runtime";

export const teamHubStateAtom = createTeamHubStateAtomFamily(connectionAtomRuntime);

/** Team hub mutations against the connected environment. */
export const teamHubActionCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "team hub action",
  execute: ({ prepared, action }: { prepared: PreparedConnection; action: TeamHubAction }) =>
    runTeamHubAction(prepared, action),
});
