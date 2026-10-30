import { useAtomValue } from "@effect/atom-react";
import { incomingTeamHubTasks } from "@t3tools/client-runtime/state/team-hub";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link, useLocation } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { LogInIcon, UsersIcon } from "lucide-react";
import { memo, useCallback } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { teamHubStateAtom } from "../../state/teamHub";
import { Badge } from "../ui/badge";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

/**
 * Team hub entry above the project list. Reads the hub subscription the app already keeps
 * open for task notifications, so it adds no traffic. Renders nothing until that state loads.
 */
export const SidebarTeamBlock = memo(function SidebarTeamBlock() {
  const environmentId = usePrimaryEnvironmentId();
  return environmentId ? <TeamBlock environmentId={environmentId} /> : null;
});

function TeamBlock({ environmentId }: { environmentId: EnvironmentId }) {
  const result = useAtomValue(teamHubStateAtom({ environmentId, input: {} }));
  const state = Option.getOrNull(AsyncResult.value(result));
  const onTeamPage = useLocation({ select: (location) => location.pathname === "/team" });
  const { isMobile, setOpenMobile } = useSidebar();
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  if (state === null) return null;

  if (state.url === null) {
    return (
      <SidebarMenu className="mt-1">
        <SidebarMenuItem>
          <SidebarMenuButton
            render={<Link to="/team" search={{ mode: "setup" }} onClick={closeMobileSidebar} />}
          >
            <UsersIcon />
            <span>Set up a team</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            render={<Link to="/team" search={{ mode: "join" }} onClick={closeMobileSidebar} />}
          >
            <LogInIcon />
            <span>Join with invite</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  const snapshot = state.snapshot;
  const teamName = snapshot?.team.name ?? "Team hub";
  const onlineCount = snapshot?.members.filter((member) => member.online).length ?? 0;
  const incomingCount = incomingTeamHubTasks(snapshot).length;
  const presence =
    state.status === "connected"
      ? `${onlineCount} online`
      : state.status === "connecting"
        ? "Connecting"
        : "Offline";
  const label = [
    teamName,
    presence,
    incomingCount > 0 ? `${incomingCount} incoming ${incomingCount === 1 ? "task" : "tasks"}` : "",
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <SidebarMenu className="mt-1">
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={onTeamPage}
          aria-label={label}
          render={<Link to="/team" onClick={closeMobileSidebar} />}
        >
          <UsersIcon />
          <span className="min-w-0 flex-1 truncate">{teamName}</span>
          <span className="shrink-0 text-xs font-normal text-sidebar-muted-foreground">
            {presence}
          </span>
          {incomingCount > 0 ? (
            <Badge size="sm" aria-hidden>
              {incomingCount}
            </Badge>
          ) : null}
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
