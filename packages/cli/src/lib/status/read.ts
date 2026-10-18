import { STATUS_VARIABLE, type Status } from "@achq/core";
import type { GitHubClient } from "@achq/github/api";
import { STATUS_INTERVAL_MS, STATUS_TIMEOUT_MS } from "../../constants.ts";

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

/** Polls ACHQ_STATUS until it shows a result newer than `since`, or times out. */
export const waitForStatus = async (
  gh: GitHubClient,
  repo: string,
  since: Date,
  options: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<Status | undefined> => {
  const { timeoutMs = STATUS_TIMEOUT_MS, intervalMs = STATUS_INTERVAL_MS, sleep = Bun.sleep, now = Date.now } = options;
  const deadline = now() + timeoutMs;
  for (;;) {
    const status = await readStatus(gh, repo);
    if (status && Date.parse(status.at) > since.getTime()) return status;
    if (now() >= deadline) return undefined;
    await sleep(intervalMs);
  }
};
