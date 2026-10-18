// Each step reads what exists, prints what would change, then applies it
// unless it's a dry run. Order: the platform → router → deployer → each App → sync.
import { randomBytes } from "node:crypto";
import { DEPLOYER_PORT, ENV, type InfraPlatform, ROUTER_PRIVATE_PORT, ROUTER_PUBLIC_PORT, type ServiceDefinition, type SyncRequest, type SyncResult } from "@achq/core";
import { GITHUB_API } from "@achq/github/api";
import type { InfraResources } from "../load/infra.ts";
import type { CreatedApp, ManifestRequest } from "../manifest.ts";
import { adminRequest } from "../router.ts";
import { type AppKeys, syncApps } from "./apps.ts";
import { formatChange, showChanges } from "./format.ts";

export type UpOptions = { prune: boolean; dryRun: boolean };

export type UpDeps = {
  /** Where the router and deployer run: `infra.platform.infra(…)`. */
  platform: InfraPlatform;
  claudeToken: string;
  /** The achq commit the router and deployer run. */
  achqRef: () => Promise<string>;
  /** Creates an App through GitHub's manifest flow. */
  createApp: (request: ManifestRequest) => Promise<CreatedApp>;
  githubApi?: string;
  /** Rewrites the router's public URL; tests point it at a fake. */
  routerUrl?: (publicUrl: string) => string;
  log: (line: string) => void;
  newKey?: () => string;
};

/** Stable JSON, so the same Apps always make the same variable. */
export const appsVariable = (apps: AppKeys) => JSON.stringify(Object.fromEntries(Object.entries(apps).sort(([a], [b]) => a.localeCompare(b))));

export const up = async (infra: InfraResources, options: UpOptions, deps: UpDeps): Promise<SyncResult | undefined> => {
  const { platform, log } = deps;
  const { dryRun } = options;
  const github = deps.githubApi ?? GITHUB_API;
  const publicUrl = (url: string | undefined) => (url && deps.routerUrl ? deps.routerUrl(url) : url);

  for (const change of await platform.prepare(dryRun)) log(`  ${formatChange(change)}`);

  // ── Router ──
  const routerEnv = (await platform.current(infra.router.name))?.env ?? {};
  // Generated once and kept in the router's env; read back from there after.
  const key = routerEnv[ENV.key] ?? (deps.newKey ?? (() => randomBytes(32).toString("hex")))();
  const apps: AppKeys = routerEnv[ENV.githubApps] ? JSON.parse(routerEnv[ENV.githubApps]) : {};
  const ref = await deps.achqRef();
  const router = (): ServiceDefinition => ({
    name: infra.router.name,
    entry: "packages/router/src/main.ts",
    env: {
      [ENV.key]: key,
      [ENV.githubApps]: appsVariable(apps),
      [ENV.deployerUrl]: platform.privateUrl(infra.deployer.name, DEPLOYER_PORT),
      [ENV.ref]: ref,
      [ENV.privatePort]: String(ROUTER_PRIVATE_PORT),
    },
    port: ROUTER_PUBLIC_PORT,
    public: true,
    sleeps: false,
  });

  const routerPlan = await platform.plan(router());
  showChanges(log, routerPlan.service, routerPlan.changes);
  let routerUrl = publicUrl(routerPlan.publicUrl);
  let routerDeployed = false;
  if (!dryRun && routerPlan.changes.length) {
    const applied = await routerPlan.apply();
    routerUrl = publicUrl(applied.publicUrl);
    routerDeployed = applied.deployed;
  }

  // ── Deployer ──
  const deployerPlan = await platform.plan({
    name: infra.deployer.name,
    entry: "packages/deployer/src/main.ts",
    env: {
      [ENV.key]: key,
      [ENV.routerUrl]: platform.privateUrl(infra.router.name, ROUTER_PRIVATE_PORT),
      ...(routerUrl && { [ENV.routerPublicUrl]: routerUrl }),
      [ENV.owners]: infra.deployer.inputs.owners.join(","),
      [ENV.claudeToken]: deps.claudeToken,
      [ENV.ref]: ref,
      [ENV.platform]: infra.platform.id,
      ...platform.containerHostEnv(),
    },
    port: DEPLOYER_PORT,
    public: false,
    sleeps: true,
  });
  showChanges(log, deployerPlan.service, deployerPlan.changes);
  if (!dryRun && deployerPlan.changes.length) await deployerPlan.apply();

  // ── GitHub Apps ──
  const hookUrl = routerUrl ? `${routerUrl}/webhook` : undefined;
  const added = await syncApps(infra.apps, { keys: apps, hookUrl, key, githubApi: github, dryRun, createApp: deps.createApp, log });

  // ── The router again, with the new Apps' keys, straight from memory ──
  if (added) {
    const plan = await platform.plan(router());
    showChanges(log, plan.service, plan.changes);
    routerDeployed = (await plan.apply()).deployed || routerDeployed;
  }

  // ── Sync ──
  if (!routerUrl) {
    log("  sync: skipped until the router exists");
    return undefined;
  }
  if (routerDeployed) {
    log("  waiting for the router to deploy…");
    await platform.waitForDeploy(infra.router.name);
  }
  const request: SyncRequest = { prune: options.prune, dryRun };
  return adminRequest<SyncResult>({ base: routerUrl, key }, "POST", "/admin/sync", request);
};
