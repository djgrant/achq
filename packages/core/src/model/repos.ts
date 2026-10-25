/**
 * An owner's or a repo's name, in characters that can't escape a path or a
 * directory: word characters, dots and dashes, and not only dots, so never `.`
 * or `..`. No anchors or lookarounds, so it also works inside a route's pattern.
 */
const SEGMENT = "[\\w.-]*[\\w-][\\w.-]*";

/** A repo's `owner/name`. Code hosts compare them case-insensitively, and so does achq. */
export const repoName = {
  /** One of its two halves, as a route's pattern. */
  segment: SEGMENT,
  /** Any `owner/name` that's safe in a path. Each code host's own `repoName` is stricter. */
  pattern: new RegExp(`^${SEGMENT}/${SEGMENT}$`),
  /** What anything kept per repo is kept under. */
  key: (repo: string) => repo.toLowerCase(),
  same: (a: string, b: string) => repoName.key(a) === repoName.key(b),
  split: (repo: string) => {
    const [owner = "", name = ""] = repo.split("/");
    return { owner, name };
  },
};

/**
 * A repo as its host identifies it, for a build service that connects to it
 * (e.g. Workers Builds): the host's ids for it and its owner, which outlive a
 * rename, and their names as the host spells them.
 */
export type RepoIdentity = { id: string; name: string; owner: { id: string; name: string } };
