// A repo as the CLI reads it: the commit that last touched some paths, the
// repo a remote names, and the ACHQ_STATUS variable the deployer writes.
import { STATUS_VARIABLE, type Status } from "@achq/core";
import type { CommitSummary, GitHub } from "@achq/utils/gh";

const STATUS_EXCERPT_CHARS = 200;

const committedAt = (commit: CommitSummary) => commit.commit.committer.date;
const newestFirst = (a: CommitSummary, b: CommitSummary) => committedAt(b).localeCompare(committedAt(a));

export const lastCommit = async (gh: GitHub, repo: string, branch: string, paths: string[]) => {
  const api = gh.repo(repo);
  const latestPerPath = await Promise.all(paths.map((path) => api.latestCommitTouching(branch, path)));
  const [latest] = latestPerPath.filter((c): c is CommitSummary => c !== undefined).sort(newestFirst);
  if (!latest) throw new Error(`No commits on ${repo}`);
  return latest.sha;
};

/** The repo a GitHub remote URL (https or ssh) names. */
export const repoOf = (remote: string, web: string) => {
  const host = new URL(web).host.replace(/[.]/g, "\\.");
  return remote.trim().match(new RegExp(`${host}[:/]([\\w.-]+/[\\w.-]+?)(?:\\.git)?$`))?.[1];
};

export const readStatus = async (gh: GitHub, repo: string): Promise<Status | undefined> => {
  const value = await gh.repo(repo).variable(STATUS_VARIABLE);
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as Status;
  } catch {
    throw new Error(`${repo}'s ${STATUS_VARIABLE} isn't JSON: ${value.slice(0, STATUS_EXCERPT_CHARS)}`);
  }
};
