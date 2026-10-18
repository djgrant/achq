import type { Status } from "@achq/core";
import { STATUS_INTERVAL_MS, STATUS_TIMEOUT_MS } from "../../constants.ts";

/** Polls the repo's status until it shows a result newer than `since`, or times out. */
export const waitForStatus = async (
  status: (repo: string) => Promise<Status | undefined>,
  repo: string,
  since: Date,
  options: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<Status | undefined> => {
  const { timeoutMs = STATUS_TIMEOUT_MS, intervalMs = STATUS_INTERVAL_MS, sleep = Bun.sleep, now = Date.now } = options;
  const deadline = now() + timeoutMs;
  for (;;) {
    const current = await status(repo);
    if (current && Date.parse(current.at) > since.getTime()) return current;
    if (now() >= deadline) return undefined;
    await sleep(intervalMs);
  }
};
