import { useAtomValue } from "@effect/atom-react";
import { incomingTeamHubTasks } from "@t3tools/client-runtime/state/team-hub";
import type { EnvironmentId } from "@t3tools/contracts";
import type { TeamHubMember } from "@t3tools/contracts/teamHub";
import { Link, useLocation } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { LogInIcon, UsersIcon } from "lucide-react";
import { memo, useCallback } from "react";

import { cn } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { teamHubStateAtom } from "../../state/teamHub";
import { Badge } from "../ui/badge";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { TeamBuddy, teamBuddyProviderLabel } from "./TeamBuddy";

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
        {snapshot && snapshot.members.length > 0 ? (
          <ul
            aria-label={`${teamName} members`}
            className="mt-0.5 ml-3.5 flex flex-col group-data-[collapsible=icon]:hidden"
          >
            {snapshot.members.map((member) => (
              <TeamMemberRow
                key={member.id}
                member={member}
                isSelf={member.id === snapshot.selfId}
                onNavigate={closeMobileSidebar}
              />
            ))}
          </ul>
        ) : null}
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function memberStatus(member: TeamHubMember) {
  const agent = teamBuddyProviderLabel(member.activity.provider);
  if (!member.online) return "offline";
  if (member.activity.working) return agent ? `working with ${agent}` : "working";
  return agent ? `idle, last used ${agent}` : "idle";
}

// Tree rows: the `before` rule is the trunk (stopping at the elbow on the last row), `after` the
// branch into the buddy.
const TeamMemberRow = memo(function TeamMemberRow(props: {
  member: TeamHubMember;
  isSelf: boolean;
  onNavigate: () => void;
}) {
  const { member } = props;
  const status = memberStatus(member);
  return (
    <li className="relative pl-3 before:absolute before:top-0 before:left-0 before:h-full before:w-px before:bg-sidebar-border last:before:h-1/2 after:absolute after:top-1/2 after:left-0 after:h-px after:w-2 after:bg-sidebar-border">
      <Link
        to="/team"
        onClick={props.onNavigate}
        title={`${member.name}: ${status}`}
        className="flex h-7 min-w-0 items-center gap-2 rounded-md px-1.5 text-sm text-sidebar-foreground outline-hidden hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring"
      >
        <TeamBuddy
          provider={member.activity.provider}
          working={member.online && member.activity.working}
          online={member.online}
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            !member.online && "text-sidebar-muted-foreground",
          )}
        >
          {member.name}
          {props.isSelf ? <span className="text-sidebar-muted-foreground"> (you)</span> : null}
        </span>
        <span className="sr-only">, {status}</span>
      </Link>
    </li>
  );
});
