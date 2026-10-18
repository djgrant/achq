import type { RailwayClient } from "../../api.ts";
import { DEPLOY_POLL_ATTEMPTS, DEPLOY_POLL_INTERVAL_MS } from "../../constants.ts";

/** Waits for a service's new deploy to succeed. */
export const waitForDeploy = async (
  railway: RailwayClient,
  environmentId: string,
  serviceId: string,
  options: { what: string; sleep?: (ms: number) => Promise<void>; log: (line: string) => void },
) => {
  const sleep = options.sleep ?? Bun.sleep;
  options.log(`  waiting for the ${options.what} to deploy…`);
  for (let i = 0; i < DEPLOY_POLL_ATTEMPTS; i++) {
    const status = (await railway.instance(environmentId, serviceId)).latestDeployment?.status;
    if (status === "SUCCESS") return;
    if (status === "FAILED" || status === "CRASHED") throw new Error(`The ${options.what}'s deploy ${status.toLowerCase()}; see its logs on Railway`);
    await sleep(DEPLOY_POLL_INTERVAL_MS);
  }
  throw new Error(`The ${options.what} hasn't deployed after five minutes`);
};
