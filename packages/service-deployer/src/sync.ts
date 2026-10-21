import { type InstalledRepo, type RepoManifest, repoName, type SyncRequest, type SyncResult } from "@achq/core";
import type { DeployerContext } from "./context.ts";
import type { DeployOutcome } from "./deploy.ts";

type Actions = {
  deploy: (host: string, repo: string, options: { dryRun: boolean }) => Promise<DeployOutcome>;
  uninstall: (host: string, repo: string, options: { dryRun: boolean }) => Promise<void>;
};

/** By repo key. */
type Manifests = Map<string, RepoManifest>;

type Listed = { repo: string; name: string };

/**
 * Whether to delete a container: its repo isn't installed, or its last known
 * manifest doesn't have it. With no known manifest (the repo has never
 * deployed), nothing of an installed repo is removed.
 */
const shouldPrune = (container: Listed, installed: boolean, manifest: RepoManifest | undefined) =>
  !installed || (manifest !== undefined && !manifest.containers.some((c) => c.name === container.name));

const deployInstalled = async (installed: InstalledRepo[], actions: Actions, dryRun: boolean, result: SyncResult): Promise<Manifests> => {
  const manifests: Manifests = new Map();
  for (const { host, repo } of installed) {
    const outcome = await actions.deploy(host, repo, { dryRun });
    if (outcome.outcome === "failed") result.failed.push({ repo, error: outcome.error ?? "failed" });
    else result[outcome.outcome].push(repo);
    if (outcome.manifest) manifests.set(repoName.key(repo), outcome.manifest);
  }
  return manifests;
};

const uninstallRemoved = async (ctx: DeployerContext, installed: Set<string>, actions: Actions, dryRun: boolean, result: SyncResult) => {
  for (const record of await ctx.store.all()) {
    if (record.state === "uninstalled" || installed.has(repoName.key(record.repo))) continue;
    await actions.uninstall(record.host, record.repo, { dryRun });
    result.uninstalled.push(record.repo);
  }
};

/** `manifests` are this sync's; for the rest, the last deployed. */
const pruneContainers = async (ctx: DeployerContext, installed: Set<string>, manifests: Manifests, dryRun: boolean, result: SyncResult) => {
  const records = new Map((await ctx.store.all()).map((r) => [repoName.key(r.repo), r]));
  const manifestOf = (key: string) => manifests.get(key) ?? records.get(key)?.deployed?.manifest;
  for (const c of await ctx.containerProvider.list()) {
    const key = repoName.key(c.repo);
    if (!shouldPrune(c, installed.has(key), manifestOf(key))) continue;
    if (!dryRun) await ctx.containerProvider.remove(c.repo, c.name);
    result.pruned.push(`${c.repo}/${c.name}`);
  }
};

/** Deploys every installed repo, uninstalls the rest, and with `prune` deletes containers no manifest has. */
export const sync = async (ctx: DeployerContext, actions: Actions, { prune = false, dryRun = false }: SyncRequest = {}): Promise<SyncResult> => {
  const result: SyncResult = { deployed: [], unchanged: [], uninstalled: [], pruned: [], failed: [] };
  // One per repo, however the code hosts spell its name.
  const installed = [...new Map((await ctx.router.installed()).map((i) => [repoName.key(i.repo), i])).values()];
  const installedKeys = new Set(installed.map((i) => repoName.key(i.repo)));
  const manifests = await deployInstalled(installed, actions, dryRun, result);
  await uninstallRemoved(ctx, installedKeys, actions, dryRun, result);
  if (prune) await pruneContainers(ctx, installedKeys, manifests, dryRun, result);
  return result;
};
