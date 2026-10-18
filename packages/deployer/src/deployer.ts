import type { DeployRecord, SyncRequest } from "@achq/core";
import { type DeployerDeps, deployerContext } from "./context.ts";
import { deploy } from "./deploy.ts";
import { createEventHandler } from "./events.ts";
import { createSerial } from "./serial.ts";
import { sync } from "./sync.ts";
import { uninstall } from "./uninstall.ts";

export const createDeployer = (deps: DeployerDeps) => {
  const ctx = deployerContext(deps);
  // One deploy or uninstall per repo at a time.
  const serial = createSerial();

  const actions = {
    deploy: (host: string, repo: string, source: string, options: { dryRun?: boolean } = {}) =>
      serial(repo.toLowerCase(), () => deploy(ctx, host, repo, source, Boolean(options.dryRun))),
    uninstall: (host: string | undefined, repo: string, source?: string, options: { dryRun?: boolean } = {}) =>
      serial(repo.toLowerCase(), () => uninstall(ctx, host, repo, source, Boolean(options.dryRun))),
  };

  /** Every repo's record, without plans: what `achq status` shows from the infra. */
  const status = async (): Promise<DeployRecord[]> => (await ctx.store.all()).map(({ plan: _plan, deployed: _deployed, ...record }) => record);

  return {
    ...actions,
    handle: createEventHandler(ctx.store, actions),
    sync: (request?: SyncRequest) => sync(ctx, actions, request),
    status,
  };
};

export type Deployer = ReturnType<typeof createDeployer>;
