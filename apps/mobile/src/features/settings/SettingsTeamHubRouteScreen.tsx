import { useAtomValue } from "@effect/atom-react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  parseTeamHubLink,
  readTeamHubInvites,
  readTeamHubState,
  runTeamHubAction,
  type TeamHubAction,
} from "@t3tools/client-runtime/state/team-hub";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import type { TeamHubInvite } from "@t3tools/contracts/teamHub";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

const actionCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "team hub action",
  execute: ({ prepared, action }: { prepared: PreparedConnection; action: TeamHubAction }) =>
    runTeamHubAction(prepared, action),
});

function Action({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      className="rounded-xl bg-accent px-4 py-2 disabled:opacity-50"
    >
      <Text className="text-center text-primary-text">{label}</Text>
    </Pressable>
  );
}

function AdminInvites({
  prepared,
  busy,
  onRevoke,
}: {
  prepared: PreparedConnection;
  busy: boolean;
  onRevoke: (inviteId: string) => void;
}) {
  const query = useMemo(
    () =>
      connectionAtomRuntime
        .atom(readTeamHubInvites(prepared))
        .pipe(
          Atom.swr({ staleTime: 4_000, revalidateOnMount: true }),
          Atom.withLabel("mobile-team-hub-invites"),
        ),
    [prepared],
  );
  const invites = Option.getOrNull(AsyncResult.value(useAtomValue(query))) ?? [];
  useEffect(() => {
    const timer = setInterval(() => appAtomRegistry.refresh(query), 5_000);
    return () => clearInterval(timer);
  }, [query]);
  return (
    <View className="gap-2">
      {invites
        .filter((item) => !item.usedAt && !item.revokedAt)
        .map((item) => (
          <View key={item.id} className="gap-1">
            <Text>Invite expires {new Date(item.expiresAt).toLocaleString()}</Text>
            <Action label="Revoke invite" disabled={busy} onPress={() => onRevoke(item.id)} />
          </View>
        ))}
    </View>
  );
}

function TeamHubContent({ prepared }: { prepared: PreparedConnection }) {
  const query = useMemo(
    () =>
      connectionAtomRuntime
        .atom(readTeamHubState(prepared))
        .pipe(
          Atom.swr({ staleTime: 4_000, revalidateOnMount: true }),
          Atom.withLabel("mobile-team-hub-state"),
        ),
    [prepared],
  );
  const result = useAtomValue(query);
  const state = Option.getOrNull(AsyncResult.value(result));
  const command = useAtomCommand(actionCommand, { reportFailure: false });
  const [link, setLink] = useState("");
  const [name, setName] = useState("");
  const [setup, setSetup] = useState(false);
  const [teamName, setTeamName] = useState("");
  const [repo, setRepo] = useState("");
  const [invite, setInvite] = useState<TeamHubInvite | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    } else setError("The team hub request failed. Check your connection and membership.");
  };
  const enroll = () => {
    const parsed = parseTeamHubLink(link);
    if (!parsed || !name.trim() || (setup && (!teamName.trim() || !repo.trim()))) {
      setError("Enter a valid hub link and all required fields.");
      return;
    }
    void act(
      setup
        ? {
            type: "bootstrap",
            input: {
              ...parsed,
              displayName: name.trim(),
              teamName: teamName.trim(),
              repo: repo.trim(),
            },
          }
        : { type: "join", input: { ...parsed, displayName: name.trim() } },
    );
  };
  if (!state) return <Text>Loading team hub…</Text>;
  const snapshot = state.snapshot;
  const self = snapshot?.members.find((member) => member.id === snapshot.selfId);
  const tasks =
    snapshot?.tasks.filter(
      (task) =>
        task.status === "suggested" &&
        (task.assigneeId === null || task.assigneeId === snapshot.selfId),
    ) ?? [];
  return (
    <View className="gap-4">
      {state.url === null ? (
        <View className="gap-3">
          <Text>
            {setup
              ? "Paste the one-time link printed by your hub."
              : "Paste an invite link from your team admin."}
          </Text>
          <TextInput
            accessibilityLabel="Team hub link"
            placeholder="Hub link"
            value={link}
            onChangeText={setLink}
            autoCapitalize="none"
            className="rounded-xl bg-grouped-card p-3 text-foreground"
          />
          <TextInput
            accessibilityLabel="Display name"
            placeholder="Your display name"
            value={name}
            onChangeText={setName}
            className="rounded-xl bg-grouped-card p-3 text-foreground"
          />
          {setup && (
            <>
              <TextInput
                accessibilityLabel="Team name"
                placeholder="Team name"
                value={teamName}
                onChangeText={setTeamName}
                className="rounded-xl bg-grouped-card p-3 text-foreground"
              />
              <TextInput
                accessibilityLabel="Git remote URL"
                placeholder="Git remote URL"
                value={repo}
                onChangeText={setRepo}
                autoCapitalize="none"
                className="rounded-xl bg-grouped-card p-3 text-foreground"
              />
            </>
          )}
          <Action label={setup ? "Create team" : "Join team"} disabled={busy} onPress={enroll} />
          <Action
            label={setup ? "Join instead" : "Set up a hub"}
            disabled={busy}
            onPress={() => setSetup(!setup)}
          />
        </View>
      ) : (
        <View className="gap-4">
          <View>
            <Text className="text-lg font-t3-medium">{snapshot?.team.name ?? state.url}</Text>
            <Text className="text-foreground-muted">
              {state.status}
              {state.error ? ` · ${state.error}` : ""}
            </Text>
          </View>
          {snapshot && (
            <>
              <Text className="text-foreground-muted">Repository: {snapshot.team.repo}</Text>
              <View className="gap-1">
                <Text className="font-t3-medium">Members</Text>
                {snapshot.members.map((member) => (
                  <View key={member.id} className="gap-1">
                    <Text>
                      {member.online ? "●" : "○"} {member.name}
                      {member.id === snapshot.selfId ? " (you)" : ""}
                    </Text>
                    {self?.role === "admin" && member.id !== snapshot.selfId && (
                      <Action
                        label={`Remove ${member.name}`}
                        disabled={busy}
                        onPress={() => void act({ type: "removeMember", memberId: member.id })}
                      />
                    )}
                  </View>
                ))}
              </View>
              {self?.role === "admin" && (
                <View className="gap-2">
                  <Action
                    label="Create invite"
                    disabled={busy}
                    onPress={() => void act({ type: "invite" })}
                  />
                  {invite && (
                    <Text selectable>
                      {new URL(
                        `/join#token=${encodeURIComponent(invite.token)}`,
                        state.url,
                      ).toString()}
                    </Text>
                  )}
                  <AdminInvites
                    prepared={prepared}
                    busy={busy}
                    onRevoke={(inviteId) => void act({ type: "revokeInvite", inviteId })}
                  />
                </View>
              )}
              <View className="gap-2">
                <Text className="font-t3-medium">Suggested tasks</Text>
                {tasks.length === 0 && (
                  <Text className="text-foreground-muted">No incoming tasks.</Text>
                )}
                {tasks.map((task) => (
                  <View key={task.id} className="gap-2 rounded-xl bg-grouped-card p-3">
                    <Text>{task.text}</Text>
                    <View className="flex-row gap-2">
                      <Action
                        label="Accept"
                        disabled={busy}
                        onPress={() =>
                          void act({ type: "decideTask", taskId: task.id, decision: "accepted" })
                        }
                      />
                      <Action
                        label="Dismiss"
                        disabled={busy}
                        onPress={() =>
                          void act({ type: "decideTask", taskId: task.id, decision: "dismissed" })
                        }
                      />
                    </View>
                  </View>
                ))}
              </View>
              <View className="gap-1">
                <Text className="font-t3-medium">Recent activity</Text>
                {snapshot.summaries.slice(0, 10).map((summary) => (
                  <Text key={summary.id}>
                    {summary.description} · {summary.branch} · {summary.files.length} files
                  </Text>
                ))}
              </View>
              {snapshot.claims.length > 0 && (
                <View className="gap-1">
                  <Text className="font-t3-medium">File claims</Text>
                  {snapshot.claims.map((claim) => (
                    <Text key={claim.path}>
                      {claim.path} ·{" "}
                      {snapshot.members.find((member) => member.id === claim.memberId)?.name ??
                        "Teammate"}
                    </Text>
                  ))}
                </View>
              )}
              {snapshot.notes.length > 0 && (
                <View className="gap-1">
                  <Text className="font-t3-medium">Notes</Text>
                  {snapshot.notes.slice(0, 10).map((note) => (
                    <Text key={note.id}>{note.text}</Text>
                  ))}
                </View>
              )}
              <View className="gap-1">
                <Text className="font-t3-medium">Interface changes</Text>
                {snapshot.contractChanges.slice(0, 10).map((change) => (
                  <Text key={change.id}>{change.description}</Text>
                ))}
              </View>
            </>
          )}
          <Action label="Leave team" disabled={busy} onPress={() => void act({ type: "leave" })} />
        </View>
      )}
      {error && (
        <Text accessibilityRole="alert" className="text-destructive">
          {error}
        </Text>
      )}
    </View>
  );
}

export function SettingsTeamHubRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const prepared = usePreparedConnection(selectedTargets[0]?.environmentId ?? null);
  return (
    <SettingsScreen title="Team hub">
      <ScrollView className="flex-1" contentContainerClassName="gap-4 px-5 py-4">
        {Option.isSome(prepared) ? (
          <TeamHubContent prepared={prepared.value} />
        ) : (
          <Text>Connect an environment to use a team hub.</Text>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
