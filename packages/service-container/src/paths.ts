import * as path from "node:path";

/** A file-name-safe form of a thread or workspace id, e.g. `owner-repo-42` for `owner/repo#42`. */
export const slug = (id: string) => id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

/** Everything lives on the volume, so a restart loses nothing. */
export const paths = (data: string) => ({
  data,
  /** HOME for agents and the runner; `~` in startup files. */
  home: path.join(data, "home"),
  /** The repo's bare mirror; worktrees hang off it. */
  mirror: path.join(data, "mirror.git"),
  /** `.achq/` extracted and bundled, per commit. */
  config: (commit: string) => path.join(data, "config", commit),
  /** Each agent's own config directory (CLAUDE_CONFIG_DIR for Claude). */
  agent: (name: string) => path.join(data, "agents", name),
  /** Where a policy provider's `install` writes its credentials, e.g. `/data/github/`. */
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
