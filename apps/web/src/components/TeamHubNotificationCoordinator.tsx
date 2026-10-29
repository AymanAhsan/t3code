import { useAtomValue } from "@effect/atom-react";
import { incomingTeamHubTasks } from "@t3tools/client-runtime/state/team-hub";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useRef } from "react";

import { getClientSettings } from "../hooks/useSettings";
import { useEnvironmentIds } from "../state/environments";
import { teamHubStateAtom } from "../state/teamHub";
import { hasNotificationSound, playNotificationSound } from "../threadNotifications";

function EnvironmentTaskNotifications({ environmentId }: { environmentId: EnvironmentId }) {
  const result = useAtomValue(teamHubStateAtom({ environmentId, input: {} }));
  const state = Option.getOrNull(AsyncResult.value(result));
  const seen = useRef(new Set<string>());

  useEffect(() => {
    if (state?.status !== "connected" || state.snapshot === null) return;
    const tasks = incomingTeamHubTasks(state.snapshot);
    const hasNewTask = tasks.some((task) => !seen.current.has(task.id));
    for (const task of tasks) seen.current.add(task.id);
    const shouldPlay = () => hasNotificationSound(getClientSettings().notificationMode);
    if (hasNewTask && shouldPlay()) void playNotificationSound("input", shouldPlay);
  }, [state]);

  return null;
}

/** Keep incoming task alerts active while viewing settings or another environment. */
export function TeamHubNotificationCoordinator() {
  return useEnvironmentIds().map((environmentId) => (
    <EnvironmentTaskNotifications key={environmentId} environmentId={environmentId} />
  ));
}
