import { repoName, type SyncRequest, type SyncResult } from "@achq/core";
import type { RepoManifest } from "@achq/core/manifest";
import type { DeployerContext } from "../context.ts";
import type { StoredRecord } from "../store.ts";
import { deploy, uninstall } from "./deploy.ts";

const containerId = (c: { repo: string; name: string }) => `${c.repo}/${c.name}`;

/**
 * The containers to prune: each whose repo isn't installed, or whose manifest
 * (this sync's, or else the last deployed) doesn't have it. A repo that has
 * never deployed has none, so nothing of it goes while it's installed.
 */
const pruned = async (ctx: DeployerContext, installed: Map<string, unknown>, manifests: Map<string, RepoManifest>, records: StoredRecord[]) => {
  const deployed = new Map(records.map((r) => [repoName.key(r.repo), r.deployed?.manifest]));
  return (await ctx.containerProvider.list()).filter((c) => {
    const key = repoName.key(c.repo);
    const manifest = manifests.get(key) ?? deployed.get(key);
    return !installed.has(key) || (manifest && !manifest.containers.some((m) => m.name === c.name));
  });
};

/**
 * Deploys every installed repo, uninstalls the rest, and with `prune` deletes
 * containers no installed repo's manifest has. `empty` syncs to no repos,
 * as `achq infra down` does, and deletes each one's ACHQ_STATUS: the router
 * it names is going. Syncs run in the background, as `ctx.store.syncs` jobs:
 * `POST /sync` starts one, `GET /sync/<id>` asks after it.
 */
export const sync = async (ctx: DeployerContext, { prune = false, dryRun = false, empty = false, expect }: SyncRequest = {}) => {
  const result: SyncResult = { deployed: [], unchanged: [], uninstalled: [], pruned: [], failed: [] };
  // By repo key: one per repo, however the code host spells its name.
  const installed = new Map(empty ? [] : (await ctx.router.installed()).map((i) => [repoName.key(i.repo), i]));
  const manifests = new Map<string, RepoManifest>();
  for (const { repo } of installed.values()) {
    const outcome = await deploy(ctx, repo, { dryRun });
    if (outcome.outcome === "failed") result.failed.push({ repo, error: outcome.error ?? "failed" });
    else result[outcome.outcome].push(repo);
    if (outcome.manifest) manifests.set(repoName.key(repo), outcome.manifest);
  }

  const records = await ctx.store.all();
  const doomed = prune ? await pruned(ctx, installed, manifests, records) : [];
  const unexpected = expect && doomed.map(containerId).filter((c) => !expect.includes(c));
  if (unexpected?.length) throw new Error(`It would prune ${unexpected.join(", ")} too, which weren't expected`);

  for (const record of records) {
    if (record.state === "uninstalled" || installed.has(repoName.key(record.repo))) continue;
    await uninstall(ctx, record.repo, { dryRun, clearStatus: empty });
    result.uninstalled.push(record.repo);
  }
  for (const c of doomed) {
    if (!dryRun) await ctx.perRepo(repoName.key(c.repo), () => ctx.containerProvider.remove(c.repo, c.name));
    result.pruned.push(containerId(c));
  }
  return result;
};
