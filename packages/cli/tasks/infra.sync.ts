import { defineTask } from "@pokit/core";
import type { SyncRequest } from "@achq/core/protocol";
import type { RouterAdmin } from "@achq/core/clients/router";
import { async } from "@achq/utils/async";
import { time } from "@achq/utils/time";
import * as v from "valibot";
import { given, sleep } from "./params.ts";

/** How long a sync, which deploys every repo, is waited for, and how often it's asked after. */
const SYNC_TIMEOUT_MS = 60 * time.MINUTE_MS;
const SYNC_INTERVAL_MS = 5000;

/** Has the deployer sync, and asks after it until it's done: it can outlast a request, and is started again if its deployer stops while it runs. */
export const infraSync = defineTask({
  label: "Sync the deployer",
  params: v.object({ admin: given<RouterAdmin>(), request: given<SyncRequest>(), sleep }),
  run: async (_r, { params: { admin, request, sleep } }) => {
    const start = () => admin.sync({ body: request }).then(({ id }) => id);
    let id = await start();
    const status = await async.pollOrThrow(
      async () => {
        const status = await admin.syncStatus({ params: { id } });
        if (status.state !== "interrupted") return status;
        // Its deployer stopped while it ran, so it's started again.
        id = await start();
        return { state: "running" } as const;
      },
      (s) => s.state !== "running",
      {
        intervalMs: SYNC_INTERVAL_MS,
        timeoutMs: SYNC_TIMEOUT_MS,
        sleep,
        timedOut: (after) => `The sync hasn't finished after ${after}; \`achq infra status\` shows each repo's deploy`,
      },
    );
    if (status.state !== "done") throw new Error("The sync failed; the deployer's logs say why");
    return status.result;
  },
});
