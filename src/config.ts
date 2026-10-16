import * as path from "node:path";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

export type Config = ReturnType<typeof loadConfig>;

export const loadConfig = () => {
  const data = process.env.DATA_DIR ?? process.env.RAILWAY_VOLUME_MOUNT_PATH ?? "/data";
  return {
    repo: required("AGENT_REPO"),
    trigger: process.env.AGENT_TRIGGER ?? "@claude",
    port: Number(process.env.PORT ?? 3000),
    maxRuns: Number(process.env.AGENT_MAX_RUNS ?? 2),
    runTimeoutMinutes: Number(process.env.AGENT_RUN_TIMEOUT_MINUTES ?? 360),
    appId: required("GITHUB_APP_ID"),
    // Railway variables can't hold newlines reliably, so accept escaped ones.
    privateKey: required("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
    webhookSecret: required("GITHUB_WEBHOOK_SECRET"),
    claudeToken: required("CLAUDE_CODE_OAUTH_TOKEN"),
    paths: paths(data),
  };
};

/** Everything lives on the volume, so a restart loses nothing. */
export const paths = (data: string) => ({
  data,
  home: path.join(data, "home"),
  github: path.join(data, "github"),
  mirror: path.join(data, "repo.git"),
  worktree: (issue: number) => path.join(data, "worktrees", `issue-${issue}`),
  lock: (issue: number) => path.join(data, "locks", `issue-${issue}`),
  state: (issue: number) => path.join(data, "issues", `${issue}.json`),
  issues: path.join(data, "issues"),
});

export type Paths = ReturnType<typeof paths>;
