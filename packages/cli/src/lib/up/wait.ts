import type { RailwayClient } from "@achq/railway/api";
import { DEPLOY_POLL_ATTEMPTS, DEPLOY_POLL_INTERVAL_MS } from "../../constants.ts";

/** Waits for the router's new deploy, so the sync reaches the new config. */
export const waitForDeploy = async (railway: RailwayClient, environmentId: string, serviceId: string, sleep: (ms: number) => Promise<void> = Bun.sleep, log: (line: string) => void) => {
  log("  waiting for the router to deploy…");
  for (let i = 0; i < DEPLOY_POLL_ATTEMPTS; i++) {
    const status = (await railway.instance(environmentId, serviceId)).latestDeployment?.status;
    if (status === "SUCCESS") return;
    if (status === "FAILED" || status === "CRASHED") throw new Error(`The router's deploy ${status.toLowerCase()}; see its logs on Railway`);
    await sleep(DEPLOY_POLL_INTERVAL_MS);
  }
  throw new Error("The router hasn't deployed after five minutes");
};
