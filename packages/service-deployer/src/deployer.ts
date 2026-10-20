import type { DeployRecord, SyncRequest } from "@achq/core";
import { keyedQueue } from "@achq/utils/async";
import { type DeployerDeps, deployerContext } from "./context.ts";
import { deploy } from "./deploy.ts";
import { createEventHandler } from "./events.ts";
import { repoKey, wireRecord } from "./store.ts";
import { sync } from "./sync.ts";
import { uninstall } from "./uninstall.ts";

type ActionOptions = { dryRun?: boolean };

export const createDeployer = (deps: DeployerDeps) => {
  const ctx = deployerContext(deps);
  // One deploy or uninstall per repo at a time.
  const perRepo = keyedQueue();

  const actions = {
    deploy: (host: string, repo: string, { dryRun = false }: ActionOptions = {}) => perRepo(repoKey(repo), () => deploy(ctx, host, repo, dryRun)),
    uninstall: (host: string, repo: string, { dryRun = false }: ActionOptions = {}) => perRepo(repoKey(repo), () => uninstall(ctx, host, repo, dryRun)),
  };

  /** Every repo's record: what `achq status` shows from the infra. */
  const status = async (): Promise<DeployRecord[]> => (await ctx.store.all()).map(wireRecord);

  return {
    ...actions,
    handle: createEventHandler(ctx.store, actions),
    sync: (request?: SyncRequest) => sync(ctx, actions, request),
    status,
  };
};

export type Deployer = ReturnType<typeof createDeployer>;
