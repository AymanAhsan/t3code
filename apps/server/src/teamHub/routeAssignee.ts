import type { TeamHubMember } from "@t3tools/contracts";

/**
 * Matches a repository-relative path against a domain glob. `**` spans
 * directories, `*` and `?` stay within one segment, and a trailing `/` owns
 * everything below it.
 */
export function matchesDomain(path: string, glob: string): boolean {
  const pattern = glob.endsWith("/") ? `${glob}**` : glob;
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*" && pattern[index + 1] === "*") {
      const slash = pattern[index + 2] === "/";
      source += slash ? "(?:.*/)?" : ".*";
      index += slash ? 2 : 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`).test(path.replace(/^\.?\//, ""));
}

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
