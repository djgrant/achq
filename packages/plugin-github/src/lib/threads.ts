export const issueThreadId = (repo: string, number: number) => `${repo}#${number}`;

export const parseThreadId = (id: string) => {
  const m = /^([^/#]+)\/([^/#]+)#(\d+)$/.exec(id);
  if (!m) throw new Error(`Not a GitHub issue thread: ${id}`);
  return { owner: m[1]!, repo: m[2]!, full: `${m[1]}/${m[2]}`, number: Number(m[3]) };
};

/** Author associations that mean write access to the repo. */
export const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export const labelNames = (labels: unknown) => (Array.isArray(labels) ? labels.map((l) => (typeof l === "string" ? l : l?.name)).filter((n) => typeof n === "string") : []);

/**
 * Message IDs must sort chronologically as strings, because the container keeps
 * `id > lastSeen`. GitHub's comment IDs grow over time, so they're zero-padded
 * to 20 digits, enough for any 64-bit ID. The opening post is all zeros, so it
 * sorts before every comment.
 */
export const messageId = (commentId: number | null) => String(commentId ?? 0).padStart(20, "0");
export const OPENING_POST_ID = messageId(null);

/** For `{title}` in branch templates: lowercase words joined by dashes, at most 40 characters. */
export const slugify = (title: string, max = 40) =>
  title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
