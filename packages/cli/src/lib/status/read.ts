import type { Status } from "@achq/core";
import { pollUntil } from "@achq/utils/async";
import { STATUS_INTERVAL_MS, STATUS_TIMEOUT_MS } from "../../constants.ts";

export type WaitOptions = { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> };

/** Whether `status` is a result written after `since`, rather than one left from before. */
const isNewer = (since: Date) => (status: Status | undefined) => !!status && Date.parse(status.at) > since.getTime();

export const waitForStatus = (
  status: (repo: string) => Promise<Status | undefined>,
  repo: string,
  since: Date,
  { timeoutMs = STATUS_TIMEOUT_MS, intervalMs = STATUS_INTERVAL_MS, sleep = Bun.sleep }: WaitOptions = {},
): Promise<Status | undefined> => pollUntil(() => status(repo), isNewer(since), { timeoutMs, intervalMs, sleep });
