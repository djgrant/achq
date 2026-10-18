import type { GitHubClient } from "@achq/github/api";
import { ACHQ_CODE_PATHS } from "../constants.ts";

/** The latest achq commit that changed the code the router and deployer run. */
export const lastCommit = async (gh: GitHubClient, source: string, paths = ACHQ_CODE_PATHS) => {
  type Commit = { sha: string; commit: { committer: { date: string } } };
  const latest = await Promise.all(paths.map(async (p) => (await gh.request<Commit[]>("GET", `/repos/${source}/commits?sha=main&per_page=1&path=${p}`))[0]));
  const found = latest.filter(Boolean).sort((a, b) => b.commit.committer.date.localeCompare(a.commit.committer.date))[0];
  if (!found) throw new Error(`No commits on ${source}`);
  return found.sha;
};
