import { isElectron } from "../../env";
import { TeamHubSettings } from "../settings/TeamHubSettings";
import type { TeamHubMode } from "./teamHubRoute";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

/** The `/team` page: the Team hub panel in the same frame as Usage and Pull Requests. */
export function TeamHubPage({ mode }: { mode: TeamHubMode }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Team hub breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1>Team hub</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer>
            <p className="max-w-prose px-3 text-sm text-muted-foreground sm:px-4">
              List the parts of the repository you own. When a teammate's agent finds follow-up work
              in your areas, it arrives here as a suggested task you can accept into a thread.
            </p>
            {/* Keyed so "Set up a team" and "Join with invite" reopen the right form. */}
            <TeamHubSettings key={mode} initialMode={mode} />
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
