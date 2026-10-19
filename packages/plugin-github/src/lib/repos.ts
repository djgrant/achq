// A repo as the CLI reads it: the commit that last touched some paths, the
// repo a remote names, and the ACHQ_STATUS variable the deployer writes.
import { STATUS_VARIABLE, type Status } from "@achq/core";
import type { GitHubClient } from "./client.ts";

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

/** The repo a GitHub remote URL (https or ssh) names. */
export const repoOf = (remote: string, web: string) => {
  const host = new URL(web).host.replace(/[.]/g, "\\.");
  return remote.trim().match(new RegExp(`${host}[:/]([\\w.-]+/[\\w.-]+?)(?:\\.git)?$`))?.[1];
};

/** The repo's ACHQ_STATUS repository variable, or undefined if the deployer hasn't written one. */
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
