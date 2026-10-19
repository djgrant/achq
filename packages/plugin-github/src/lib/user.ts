// GitHub as your `gh` login: `achq install`, `uninstall` and the repo commands act as you, not as the App.
import { GitHubClient } from "./client.ts";

type Env = Record<string, string | undefined>;

/** `GH_TOKEN` in `env` wins, as it does for gh itself; tests set it to skip gh. */
export const ghToken = (env: Env = {}) => {
  if (env.GH_TOKEN) return env.GH_TOKEN;
  const { stdout, success, stderr } = Bun.spawnSync(["gh", "auth", "token"], { stderr: "pipe" });
  if (!success) throw new Error(`Needs a gh login (gh auth login): ${stderr.toString().trim()}`);
  return stdout.toString().trim();
};

export const userGitHub = (baseUrl: string, env: Env = {}) => {
  let token: string | undefined;
  return new GitHubClient(() => `token ${(token ??= ghToken(env))}`, baseUrl);
};
