import { useAtomValue } from "@effect/atom-react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  formatTeamHubContract,
  incomingTeamHubTasks,
  teamHubActionErrorMessage,
} from "@t3tools/client-runtime/state/team-hub";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";

import { usePreparedConnection } from "~/state/session";
import { teamHubActionCommand, teamHubStateAtom } from "~/state/teamHub";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";

function ConnectedIncomingTask({ prepared }: { prepared: PreparedConnection }) {
  const query = teamHubStateAtom({ environmentId: prepared.environmentId, input: {} });
  const result = useAtomValue(query);
  const state = Option.getOrNull(AsyncResult.value(result));
  const command = useAtomCommand(teamHubActionCommand, { reportFailure: false });
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [decided, setDecided] = useState<string[]>([]);
  const [error, setError] = useState<{ taskId: string; message: string } | null>(null);
  const tasks = incomingTeamHubTasks(state?.snapshot ?? null).filter(
    (task) => !decided.includes(task.id),
  );
  const task = tasks[0];
  const connected = state?.status === "connected";

  if (!task) return null;
  const author = state?.snapshot?.members.find((member) => member.id === task.authorId);

  const decide = async (decision: "accepted" | "dismissed") => {
    setBusy(true);
    setError(null);
    const outcome = await command({
      prepared,
      action: { type: "decideTask", taskId: task.id, decision },
    });
    setBusy(false);
    if (!AsyncResult.isSuccess(outcome)) {
      setError({
        taskId: task.id,
        message: teamHubActionErrorMessage(squashAtomCommandFailure(outcome)),
      });
      return;
    }
    setDecided((ids) => [...ids, task.id]);
    if (decision === "accepted" && "threadId" in outcome.value && outcome.value.threadId !== null) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(
          scopeThreadRef(prepared.environmentId, outcome.value.threadId),
        ),
      });
    }
  };

  return (
    <div className="shrink-0 px-3 pb-3 sm:px-5">
      <section
        aria-label="Incoming team task"
        className="max-w-sm rounded-xl border border-border bg-card p-3 shadow-md"
      >
        <div aria-live="polite" aria-atomic="true">
          <p className="text-xs text-muted-foreground">
            Task from {author?.name ?? "Teammate"}
            {tasks.length > 1 ? ` · ${tasks.length} pending` : ""}
          </p>
          <p className="mt-1 max-h-28 overflow-y-auto text-sm break-words whitespace-pre-wrap">
            {task.text}
          </p>
          {task.contract !== null ? (
            <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
              Contract: {formatTeamHubContract(task.contract)}
            </p>
          ) : null}
        </div>
        {error?.taskId === task.id ? (
          <p role="alert" className="mt-2 text-xs text-error">
            {error.message}
          </p>
        ) : null}
        {!connected ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Reconnect to the team hub to respond.
          </p>
        ) : null}
        <div className="mt-3 flex gap-2">
          <Button size="xs" disabled={busy || !connected} onClick={() => void decide("accepted")}>
            Accept
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !connected}
            onClick={() => void decide("dismissed")}
          >
            Dismiss
          </Button>
        </div>
      </section>
    </div>
  );
}

export function IncomingTeamHubTask({ environmentId }: { environmentId: EnvironmentId }) {
  const prepared = usePreparedConnection(environmentId);
  return Option.isSome(prepared) ? (
    <ConnectedIncomingTask key={environmentId} prepared={prepared.value} />
  ) : null;
}
