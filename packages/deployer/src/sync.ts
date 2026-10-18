import type { Installation, RepoPlan, SyncRequest, SyncResult } from "@achq/core";
import type { DeployerContext } from "./context.ts";
import type { DeployOutcome } from "./deploy.ts";

type Actions = {
  deploy: (host: string, repo: string, source: string, options: { dryRun: boolean }) => Promise<DeployOutcome>;
  uninstall: (host: undefined, repo: string, source: undefined, options: { dryRun: boolean }) => Promise<void>;
};

/** Deploys every installed repo, uninstalls the rest, and with `prune` deletes containers no plan has. */
export const sync = async (ctx: DeployerContext, actions: Actions, { prune = false, dryRun = false }: SyncRequest = {}): Promise<SyncResult> => {
  const result: SyncResult = { deployed: [], unchanged: [], uninstalled: [], pruned: [], failed: [] };
  const installations: Installation[] = await ctx.router.installations();
  const installed = new Map(installations.map((i) => [i.repo.toLowerCase(), i]));
  const plans = new Map<string, RepoPlan | undefined>();

  for (const i of installed.values()) {
    const outcome = await actions.deploy(i.provider, i.repo, i.source, { dryRun });
    if (outcome.outcome === "failed") result.failed.push({ repo: i.repo, error: outcome.error ?? "failed" });
    else result[outcome.outcome].push(i.repo);
    if (outcome.plan) plans.set(i.repo.toLowerCase(), outcome.plan);
  }
  for (const record of await ctx.store.all()) {
    if (record.state === "uninstalled" || installed.has(record.repo.toLowerCase())) continue;
    await actions.uninstall(undefined, record.repo, undefined, { dryRun });
    result.uninstalled.push(record.repo);
  }
  if (prune) {
    const records = new Map((await ctx.store.all()).map((r) => [r.repo.toLowerCase(), r]));
    for (const c of await ctx.containerHost.list()) {
      const key = c.repo.toLowerCase();
      // A repo still installed keeps every container its last known plan has.
      // With no known plan (it has never deployed), nothing of it is removed.
      const plan = plans.get(key) ?? records.get(key)?.deployed?.plan;
      const remove = !installed.has(key) || (plan !== undefined && !plan.containers.some((p) => p.name === c.name));
      if (!remove) continue;
      if (!dryRun) await ctx.containerHost.remove(c.repo, c.name);
      result.pruned.push(`${c.repo}/${c.name}`);
    }
  }
  return result;
};
