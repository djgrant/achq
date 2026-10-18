import { STATUS_VARIABLE, type Status } from "@achq/core";
import type { GitHubClient } from "../api/client.ts";

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
