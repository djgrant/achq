import type { GitHubClient } from "../lib/client.ts";

/** The latest commit on `branch` that changed any of `paths`. */
export const lastCommit = async (gh: GitHubClient, repo: string, branch: string, paths: string[]) => {
  type Commit = { sha: string; commit: { committer: { date: string } } };
  const latest = await Promise.all(
    paths.map(async (p) => (await gh.request<Commit[]>("GET", `/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=1&path=${p}`))[0]),
  );
  const found = latest.filter(Boolean).sort((a, b) => b.commit.committer.date.localeCompare(a.commit.committer.date))[0];
  if (!found) throw new Error(`No commits on ${repo}`);
  return found.sha;
};
