import { defineTask } from "@pokit/core";
import type { RouterAdmin } from "@achq/core/clients/router";
import { async } from "@achq/utils/async";
import { time } from "@achq/utils/time";
import { z } from "zod";
import { shortSha } from "../renderers/status.ts";
import { given, log, sleep } from "./params.ts";

/** How long a new deployer is waited for to replace the one running, and how often it's asked what it runs. */
const DEPLOYER_VERSION_TIMEOUT_MS = 10 * time.MINUTE_MS;
const DEPLOYER_VERSION_INTERVAL_MS = 5000;

/** Waits until the deployer runs `ref`. */
export const infraAwaitDeployer = defineTask({
  label: "Wait for the deployer",
  params: z.object({ admin: given<RouterAdmin>(), ref: z.string(), log, sleep }),
  run: async (_r, { params: { admin, ref, log, sleep } }) => {
    // A deployer, or router, that's still starting doesn't answer, which counts as not yet.
    const running = () => admin.deployerVersion().then((v) => v.ref, () => undefined);
    if ((await running()) === ref) return;
    log(`  waiting for the deployer to run ${shortSha(ref)}…`);
    await async.pollOrThrow(running, (r) => r === ref, {
      intervalMs: DEPLOYER_VERSION_INTERVAL_MS,
      timeoutMs: DEPLOYER_VERSION_TIMEOUT_MS,
      sleep,
      timedOut: (after) => `The deployer isn't running ${shortSha(ref)} after ${after}; see its logs on its container provider`,
    });
  },
});
