// GitHub as your `gh` login: `achq install`, `uninstall` and the repo commands act as you, not as the App.
import { GitHubClient } from "../api/client.ts";

export const ghToken = () => {
  const { stdout, success, stderr } = Bun.spawnSync(["gh", "auth", "token"], { stderr: "pipe" });
  if (!success) throw new Error(`Needs a gh login (gh auth login): ${stderr.toString().trim()}`);
  return stdout.toString().trim();
};

export const userGitHub = (baseUrl: string) => {
  let token: string | undefined;
  return new GitHubClient(() => `token ${(token ??= ghToken())}`, baseUrl);
};
