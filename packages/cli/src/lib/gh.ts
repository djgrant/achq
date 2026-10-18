// GitHub as your `gh` login. Commands take a `GitHubClient`, so tests point it at a fake.
import { STATUS_VARIABLE, type Status } from "@achq/core";
import { GITHUB_API, GitHubClient } from "@achq/github/api";

export const ghToken = () => {
  const { stdout, success, stderr } = Bun.spawnSync(["gh", "auth", "token"], { stderr: "pipe" });
  if (!success) throw new Error(`Needs a gh login (gh auth login): ${stderr.toString().trim()}`);
  return stdout.toString().trim();
};

export const userGitHub = (baseUrl = process.env.ACHQ_GITHUB_API ?? GITHUB_API) => {
  let token: string | undefined;
  return new GitHubClient(() => `token ${(token ??= ghToken())}`, baseUrl);
};

/** The repo's ACHQ_STATUS, or undefined if the deployer hasn't written one. */
export const readStatus = async (gh: GitHubClient, repo: string): Promise<Status | undefined> => {
  const res = await gh.raw("GET", `/repos/${repo}/actions/variables/${STATUS_VARIABLE}`);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`Reading ${STATUS_VARIABLE} on ${repo}: ${res.status} ${await res.text()}`);
  const { value } = (await res.json()) as { value: string };
  try {
    return JSON.parse(value) as Status;
  } catch {
    throw new Error(`${repo}'s ${STATUS_VARIABLE} isn't JSON: ${value.slice(0, 200)}`);
  }
};

/** The latest achq commit that changed the code the router and deployer run. */
export const lastCommit = async (gh: GitHubClient, source: string, paths = ["packages", "package.json", "bun.lock"]) => {
  type Commit = { sha: string; commit: { committer: { date: string } } };
  const latest = await Promise.all(paths.map(async (p) => (await gh.request<Commit[]>("GET", `/repos/${source}/commits?sha=main&per_page=1&path=${p}`))[0]));
  const found = latest.filter(Boolean).sort((a, b) => b.commit.committer.date.localeCompare(a.commit.committer.date))[0];
  if (!found) throw new Error(`No commits on ${source}`);
  return found.sha;
};
