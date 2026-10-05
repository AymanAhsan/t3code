import { useAtomValue } from "@effect/atom-react";
import {
  parseTeamHubLink,
  readTeamHubInvites,
  readTeamHubState,
  runTeamHubAction,
  type TeamHubAction,
} from "@t3tools/client-runtime/state/team-hub";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { TeamHubInvite } from "@t3tools/contracts/teamHub";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useMemo, useState } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { usePreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";

const actionCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "team hub action",
  execute: ({ prepared, action }: { prepared: PreparedConnection; action: TeamHubAction }) =>
    runTeamHubAction(prepared, action),
});

function inviteLink(url: string, invite: TeamHubInvite): string {
  const link = new URL("/join", url);
  link.hash = `token=${encodeURIComponent(invite.token)}`;
  return link.toString();
}

// Invite links reuse the address this hub was set up with, so a loopback address only works
// on the admin's own machine.
function isLoopbackAddress(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "[::1]" ||
      host.startsWith("127.")
    );
  } catch {
    return false;
  }
}

function AdminInvites({
  prepared,
  url,
  invite,
  busy,
  onCreate,
  onRevoke,
}: {
  prepared: PreparedConnection;
  url: string;
  invite: TeamHubInvite | null;
  busy: boolean;
  onCreate: () => void;
  onRevoke: (inviteId: string) => void;
}) {
  const query = useMemo(
    () =>
      connectionAtomRuntime
        .atom(readTeamHubInvites(prepared))
        .pipe(
          Atom.swr({ staleTime: 4_000, revalidateOnMount: true }),
          Atom.withLabel("team-hub-invites"),
        ),
    [prepared],
  );
  const invites = Option.getOrNull(AsyncResult.value(useAtomValue(query))) ?? [];
  useEffect(() => {
    const timer = setInterval(() => appAtomRegistry.refresh(query), 5_000);
    return () => clearInterval(timer);
  }, [query]);
  return (
    <div className="space-y-2">
      <h3 className="font-medium">Invites</h3>
      <Button size="sm" variant="outline" disabled={busy} onClick={onCreate}>
        Create invite
      </Button>
      {isLoopbackAddress(url) && (
        <p className="text-warning">
          This hub's address is {new URL(url).host}, which only works on this computer. Teammates
          can't use invites from it. Set the hub up again from a link with an address they can
          reach.
        </p>
      )}
      {invite && (
        <>
          <p>Invite expires {new Date(invite.expiresAt).toLocaleString()}.</p>
          <Input
            aria-label="Invite link"
            readOnly
            value={inviteLink(url, invite)}
            onFocus={(event) => event.target.select()}
          />
        </>
      )}
      <ul className="space-y-1">
        {invites
          .filter((item) => !item.usedAt && !item.revokedAt)
          .map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-2">
              <span>Expires {new Date(item.expiresAt).toLocaleString()}</span>
              <Button size="xs" variant="outline" disabled={busy} onClick={() => onRevoke(item.id)}>
                Revoke
              </Button>
            </li>
          ))}
      </ul>
    </div>
  );
}

function ConnectedTeamHub({ prepared }: { prepared: PreparedConnection }) {
  const query = useMemo(
    () =>
      connectionAtomRuntime
        .atom(readTeamHubState(prepared))
        .pipe(
          Atom.swr({ staleTime: 4_000, revalidateOnMount: true }),
          Atom.withLabel("team-hub-state"),
        ),
    [prepared],
  );
  const result = useAtomValue(query);
  const state = Option.getOrNull(AsyncResult.value(result));
  const [joinLink, setJoinLink] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [settingUp, setSettingUp] = useState(false);
  const [teamName, setTeamName] = useState("");
  const [repo, setRepo] = useState("");
  const [invite, setInvite] = useState<TeamHubInvite | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const command = useAtomCommand(actionCommand, { reportFailure: false });

  useEffect(() => {
    const timer = setInterval(() => appAtomRegistry.refresh(query), 5_000);
    return () => clearInterval(timer);
  }, [query]);

  const act = async (action: TeamHubAction) => {
    setBusy(true);
    setError(null);
    const outcome = await command({ prepared, action });
    setBusy(false);
    if (AsyncResult.isSuccess(outcome)) {
      if (action.type === "invite") setInvite(outcome.value as TeamHubInvite);
      appAtomRegistry.refresh(query);
    } else {
      setError("The team hub request failed. Check the hub address, membership, and connection.");
    }
  };

  if (state === null) return <p className="text-sm text-muted-foreground">Loading team hub…</p>;
  const snapshot = state.snapshot;
  const self = snapshot?.members.find((member) => member.id === snapshot.selfId);
  const pendingTasks =
    snapshot?.tasks.filter(
      (task) =>
        task.status === "suggested" &&
        (task.assigneeId === null || task.assigneeId === snapshot.selfId),
    ) ?? [];

  return (
    <div className="space-y-5 py-3 text-sm">
      {state.url === null ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = parseTeamHubLink(joinLink);
            if (
              !parsed ||
              !displayName.trim() ||
              (settingUp && (!teamName.trim() || !repo.trim()))
            ) {
              setError("Enter a valid hub link and all required fields.");
              return;
            }
            void act(
              settingUp
                ? {
                    type: "bootstrap",
                    input: {
                      ...parsed,
                      displayName: displayName.trim(),
                      teamName: teamName.trim(),
                      repo: repo.trim(),
                    },
                  }
                : { type: "join", input: { ...parsed, displayName: displayName.trim() } },
            );
          }}
        >
          <p className="text-muted-foreground">
            {settingUp
              ? "Create the first team with the setup link printed by your hub."
              : "Join a team with the invite link from its admin."}
          </p>
          <Input
            aria-label={settingUp ? "Hub setup link" : "Team invite link"}
            placeholder={
              settingUp
                ? "https://hub.example.com/setup#token=…"
                : "https://hub.example.com/join#token=…"
            }
            value={joinLink}
            onChange={(event) => setJoinLink(event.target.value)}
          />
          <Input
            aria-label="Your display name"
            placeholder="Your display name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
          {settingUp && (
            <>
              <Input
                aria-label="Team name"
                placeholder="Team name"
                value={teamName}
                onChange={(event) => setTeamName(event.target.value)}
              />
              <Input
                aria-label="Git repository"
                placeholder="Git remote URL"
                value={repo}
                onChange={(event) => setRepo(event.target.value)}
              />
            </>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              {settingUp ? "Create team" : "Join team"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setSettingUp(!settingUp);
                setError(null);
              }}
            >
              {settingUp ? "Join instead" : "Set up a hub"}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <strong>{snapshot?.team.name ?? state.url}</strong>
              <p className="text-muted-foreground">
                {state.status}
                {state.error ? ` · ${state.error}` : ""}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void act({ type: "leave" })}
            >
              Leave
            </Button>
          </div>
          {snapshot && (
            <>
              <p className="text-muted-foreground">Repo: {snapshot.team.repo}</p>
              <div>
                <h3 className="font-medium">Members</h3>
                <ul className="mt-1 space-y-1">
                  {snapshot.members.map((member) => (
                    <li key={member.id} className="flex items-center justify-between gap-2">
                      <span>
                        {member.online ? "●" : "○"} {member.name}
                        {member.id === snapshot.selfId ? " (you)" : ""}
                      </span>
                      {self?.role === "admin" && member.id !== snapshot.selfId && (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void act({ type: "removeMember", memberId: member.id })}
                        >
                          Remove
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
              {self?.role === "admin" && (
                <AdminInvites
                  prepared={prepared}
                  url={state.url}
                  invite={invite}
                  busy={busy}
                  onCreate={() => void act({ type: "invite" })}
                  onRevoke={(inviteId) => void act({ type: "revokeInvite", inviteId })}
                />
              )}
              <div>
                <h3 className="font-medium">Suggested tasks</h3>
                {pendingTasks.length === 0 ? (
                  <p className="text-muted-foreground">No incoming tasks.</p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {pendingTasks.map((task) => (
                      <li key={task.id} className="space-y-1 rounded-md border p-2">
                        <p>{task.text}</p>
                        <div className="flex gap-2">
                          <Button
                            size="xs"
                            disabled={busy}
                            onClick={() =>
                              void act({
                                type: "decideTask",
                                taskId: task.id,
                                decision: "accepted",
                              })
                            }
                          >
                            Accept
                          </Button>
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={busy}
                            onClick={() =>
                              void act({
                                type: "decideTask",
                                taskId: task.id,
                                decision: "dismissed",
                              })
                            }
                          >
                            Dismiss
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h3 className="font-medium">Recent activity</h3>
                <ul className="mt-1 space-y-1 text-muted-foreground">
                  {snapshot.summaries.slice(0, 10).map((summary) => (
                    <li key={summary.id}>
                      {snapshot.members.find((member) => member.id === summary.memberId)?.name ??
                        "Teammate"}{" "}
                      · {summary.description} · {summary.branch} · {summary.files.length} files
                    </li>
                  ))}
                </ul>
              </div>
              {snapshot.claims.length > 0 && (
                <div>
                  <h3 className="font-medium">File claims</h3>
                  <ul className="mt-1 space-y-1 text-muted-foreground">
                    {snapshot.claims.map((claim) => (
                      <li key={claim.path}>
                        {claim.path} ·{" "}
                        {snapshot.members.find((member) => member.id === claim.memberId)?.name ??
                          "Teammate"}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {snapshot.notes.length > 0 && (
                <div>
                  <h3 className="font-medium">Notes</h3>
                  <ul className="mt-1 space-y-1 text-muted-foreground">
                    {snapshot.notes.slice(0, 10).map((note) => (
                      <li key={note.id}>{note.text}</li>
                    ))}
                  </ul>
                </div>
              )}
              {snapshot.contractChanges.length > 0 && (
                <div>
                  <h3 className="font-medium">Interface changes</h3>
                  <ul className="mt-1 space-y-1 text-muted-foreground">
                    {snapshot.contractChanges.slice(0, 10).map((change) => (
                      <li key={change.id}>
                        {change.description}: {change.paths.join(", ")}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function TeamHubSettings() {
  const environmentId = usePrimaryEnvironmentId();
  const prepared = usePreparedConnection(environmentId);
  return (
    <SettingsSection id="team-hub" title="Team hub">
      {Option.isSome(prepared) ? (
        <ConnectedTeamHub prepared={prepared.value} />
      ) : (
        <p className="py-3 text-sm text-muted-foreground">
          Connect an environment to use a team hub.
        </p>
      )}
    </SettingsSection>
  );
}
