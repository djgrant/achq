// Each step reads what exists, prints what would change, then applies it
// unless it's a dry run. Order: the platform → router → deployer → each
// provider's resources (e.g. GitHub Apps) → sync.
import { randomBytes } from "node:crypto";
import { type Change, DEPLOYER_PORT, ENV, type InfraPlatform, ROUTER_PRIVATE_PORT, ROUTER_PUBLIC_PORT, type ServiceDefinition, type SyncRequest, type SyncResult } from "@achq/core";
import type { InfraResources } from "../load/infra.ts";
import { adminRequest } from "../router.ts";
import { formatChange, showChanges } from "./format.ts";

export type UpOptions = { prune: boolean; dryRun: boolean };

export type UpDeps = {
  /** Where the router and deployer run: `infra.platform.infra(…)`. */
  platform: InfraPlatform;
  /** What every container gets: the agent runtimes' variables. */
  containerEnv: Record<string, string>;
  /** The achq commit the router and deployer run. */
  achqRef: () => Promise<string>;
  /** Opens `url` in your browser to `what`, e.g. to create an App. */
  open: (url: string, what: string) => Promise<void>;
  /** Rewrites the router's public URL; tests point it at a fake. */
  routerUrl?: (publicUrl: string) => string;
  log: (line: string) => void;
  newKey?: () => string;
};

export const up = async (infra: InfraResources, options: UpOptions, deps: UpDeps): Promise<SyncResult | undefined> => {
  const { platform, log } = deps;
  const { dryRun } = options;
  const publicUrl = (url: string | undefined) => (url && deps.routerUrl ? deps.routerUrl(url) : url);

  for (const change of await platform.prepare(dryRun)) log(`  ${formatChange(change)}`);

  // ── Router ──
  const routerEnv = (await platform.current(infra.router.name))?.env ?? {};
  // Generated once and kept in the router's env; read back from there after.
  const key = routerEnv[ENV.key] ?? (deps.newKey ?? (() => randomBytes(32).toString("hex")))();
  // The variables each provider keeps on the router, as they are now.
  let providerEnv: Record<string, string> = Object.assign({}, ...infra.providers.map((p) => p.infra.routerEnv(routerEnv)));
  const ref = await deps.achqRef();
  const router = (): ServiceDefinition => ({
    name: infra.router.name,
    entry: "packages/router/src/main.ts",
    env: {
      ...providerEnv,
      [ENV.key]: key,
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
      [ENV.containerEnv]: JSON.stringify(deps.containerEnv),
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

  // ── Each provider's resources ──
  const hookUrl = routerUrl ? `${routerUrl}/webhook` : undefined;
  const after: Record<string, string> = {};
  for (const p of infra.providers) {
    const step = { current: routerEnv, hookUrl, key, dryRun, open: deps.open, show: (subject: string, changes: Change[]) => showChanges(log, subject, changes), log };
    Object.assign(after, await p.infra.up(p.resources, step));
  }

  // ── The router again, with what the providers created (e.g. new Apps' keys), straight from memory ──
  if (JSON.stringify(after) !== JSON.stringify(providerEnv)) {
    providerEnv = after;
    const plan = await platform.plan(router());
    showChanges(log, plan.service, plan.changes);
    if (!dryRun && plan.changes.length) routerDeployed = (await plan.apply()).deployed || routerDeployed;
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
