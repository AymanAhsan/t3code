import type { TeamHubMember } from "@t3tools/contracts";

import { matchesDomain } from "@t3tools/contracts/teamHub";
export { matchesDomain } from "@t3tools/contracts/teamHub";

/**
 * Picks the one teammate whose domains own every given path. Returns no
 * assignee when nobody or more than one teammate matches, with the matching
 * teammates as candidates. Never routes to the caller.
 */
export function routeAssignee(
  members: ReadonlyArray<TeamHubMember>,
  selfId: string,
  paths: ReadonlyArray<string>,
): { readonly assigneeId: string | null; readonly candidates: ReadonlyArray<TeamHubMember> } {
  const candidates = members.filter(
    (member) =>
      member.id !== selfId &&
      paths.length > 0 &&
      paths.every((path) => member.domains.some((glob) => matchesDomain(path, glob))),
  );
  return { assigneeId: candidates.length === 1 ? candidates[0]!.id : null, candidates };
}
