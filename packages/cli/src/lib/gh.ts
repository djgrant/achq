// GitHub as your `gh` login. Commands take a `GitHubClient`, so tests point it at a fake.
import { GITHUB_API, GitHubClient } from "@achq/github/api";
import { CLI_ENV } from "../constants.ts";

export const ghToken = () => {
  const { stdout, success, stderr } = Bun.spawnSync(["gh", "auth", "token"], { stderr: "pipe" });
  if (!success) throw new Error(`Needs a gh login (gh auth login): ${stderr.toString().trim()}`);
  return stdout.toString().trim();
};

export const userGitHub = (baseUrl = process.env[CLI_ENV.githubApi] ?? GITHUB_API) => {
  let token: string | undefined;
  return new GitHubClient(() => `token ${(token ??= ghToken())}`, baseUrl);
};
