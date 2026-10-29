import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import {
  createTeamHubStateAtomFamily,
  runTeamHubAction,
  type TeamHubAction,
} from "@t3tools/client-runtime/state/team-hub";

import { connectionAtomRuntime } from "~/connection/runtime";
import { environmentShell } from "./shell";

export const teamHubStateAtom = createTeamHubStateAtomFamily(connectionAtomRuntime);

/** Team hub mutations against the connected environment. */
export const teamHubActionCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "team hub action",
  execute: (
    { prepared, action }: { prepared: PreparedConnection; action: TeamHubAction },
    registry,
  ) =>
    runTeamHubAction(prepared, action, {
      registry,
      shell: environmentShell.stateValueAtom(prepared.environmentId),
    }),
});
