// Builds a graph of everything the infra declares, each resource expanded by
// its platform, then plans it (a dry run) or applies it, then syncs installed
// repos through the router.
import type { Expander, RouterHandle, SyncRequest, SyncResult } from "@achq/core";
import { type Change, formatChange, graph, type Run } from "@achq/reconcile";
import type { InfraResources } from "../load/infra.ts";
import { adminRequest } from "../router.ts";
import { expandInfra } from "./expand.ts";

export type UpOptions = { prune: boolean; dryRun: boolean };

export type UpDeps = {
  expanders: Expander[];
  log: (line: string) => void;
};

export const up = async (infra: InfraResources, options: UpOptions, deps: UpDeps): Promise<SyncResult | undefined> => {
  const { log } = deps;
  const g = graph();
  const router = expandInfra(infra.resources, deps.expanders, g)<RouterHandle>(infra.router);

  const show = (change: Change) => log(`  ${formatChange(change)}`);
  let run: Run;
  if (options.dryRun) {
    run = await g.plan();
    run.changes.forEach(show);
  } else {
    run = await g.apply(show);
  }
  if (!run.changes.length) log("  up to date");
  for (const note of run.notes) log(`  ! ${note}`);

  if (!options.dryRun) await router.live(run);
  const access = await router.access(run);
  if (!access) {
    log("  sync: skipped until the router exists");
    return undefined;
  }
  const request: SyncRequest = { prune: options.prune, dryRun: options.dryRun };
  return adminRequest<SyncResult>(access, "POST", "/admin/sync", request);
};
