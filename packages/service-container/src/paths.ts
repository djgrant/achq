import * as path from "node:path";

const UNSAFE_RUN = /[^A-Za-z0-9._-]+/g;
const EDGE_DASHES = /^-+|-+$/g;

/**
 * A file-name-safe form of a thread or workspace id, e.g. `owner-repo-42` for
 * `owner/repo#42`. Not `safeFileName`: these names are already on volumes, and
 * runs collapse to one dash so they stay readable.
 */
export const slug = (id: string) => id.replace(UNSAFE_RUN, "-").replace(EDGE_DASHES, "");

/** Everything lives on the volume, so a restart loses nothing. */
export const paths = (data: string) => ({
  data,
  /** HOME for agents and the runner; `~` in startup files. */
  home: path.join(data, "home"),
  mirror: path.join(data, "mirror.git"),
  config: (commit: string) => path.join(data, "config", commit),
  /** Each agent's own config directory (CLAUDE_CONFIG_DIR for Claude). */
  agent: (name: string) => path.join(data, "agents", name),
  policyProvider: (id: string) => path.join(data, id),
  /** The env (credentials, git identity) the last run gave agents, for `resume`. Mode 600. */
  agentEnv: path.join(data, "credentials", "agent-env.json"),
  threads: path.join(data, "threads"),
  thread: (threadKey: string) => path.join(data, "threads", `${slug(threadKey)}.json`),
  worktree: (workspace: string, threadKey: string) => path.join(data, "worktrees", workspace, slug(threadKey)),
  /** One run per thread per workspace: runs and `resume` take this lock. */
  lock: (workspace: string, threadKey: string) => path.join(data, "locks", workspace, slug(threadKey)),
  deliveries: path.join(data, "deliveries"),
});

export type Paths = ReturnType<typeof paths>;
