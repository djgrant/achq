import { defineTask } from "@pokit/core";
import { async } from "@achq/utils/async";
import { time } from "@achq/utils/time";
import { z } from "zod";
import type { RepoHere } from "../io/workdir.ts";
import { given, sleep } from "./params.ts";

/** How long a deploy's result is waited for, and how often ACHQ_STATUS is read: a deploy can build images for minutes. */
export const STATUS_TIMEOUT_MS = 20 * time.MINUTE_MS;
const STATUS_INTERVAL_MS = 5000;

/**
 * The repo's ACHQ_STATUS, if it has one. Given `since`, the first written after
 * it rather than one left from before, waited for: undefined if none comes in time.
 */
export const repoReadStatus = defineTask({
  label: "Read the repo's status",
  params: z.object({ here: given<RepoHere>(), since: z.date().optional(), sleep }),
  run: async (_r, { params: { here, since, sleep } }) => {
    const { repo, codeHost } = here;
    if (!since) return codeHost.status(repo);
    return async.pollUntil(() => codeHost.status(repo), (found) => !!found && Date.parse(found.at) > since.getTime(), {
      timeoutMs: STATUS_TIMEOUT_MS,
      intervalMs: STATUS_INTERVAL_MS,
      sleep,
    });
  },
});
