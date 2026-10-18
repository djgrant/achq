// Each step reads what exists, prints what would change, then applies it
// unless it's a dry run. Order: Railway project → router → deployer → each App → sync.
import { randomBytes } from "node:crypto";
import { DEPLOYER_PORT, ENV, ROUTER_PRIVATE_PORT, type SyncRequest, type SyncResult } from "@achq/core";
import { GITHUB_API } from "@achq/github/api";
import type { RailwayClient } from "@achq/railway/api";
import { deployerServiceSpec, hostServiceName, planService, privateUrl, routerServiceSpec } from "@achq/railway/runtime";
import type { InfraResources } from "../load/infra.ts";
import type { CreatedApp, ManifestRequest } from "../manifest.ts";
import { adminRequest, routerBase } from "../router.ts";
import { type AppKeys, syncApps } from "./apps.ts";
import { showChanges } from "./format.ts";
import { railwayProject } from "./project.ts";
import { waitForDeploy } from "./wait.ts";

export type UpOptions = { prune: boolean; dryRun: boolean };

export type UpDeps = {
  railway: RailwayClient;
  railwayToken: string;
  claudeToken: string;
  workspaceId?: string;
  /** The achq commit the router and deployer run. */
  achqRef: () => Promise<string>;
  /** Creates an App through GitHub's manifest flow. */
  createApp: (request: ManifestRequest) => Promise<CreatedApp>;
  githubApi?: string;
  /** The router's public base URL from its domain; tests point it at a fake. */
  routerBase?: (domain: string) => string;
  log: (line: string) => void;
  newKey?: () => string;
  sleep?: (ms: number) => Promise<void>;
};

export const up = async (infra: InfraResources, options: UpOptions, deps: UpDeps): Promise<SyncResult | undefined> => {
  const { railway, log, dryRun } = { ...deps, dryRun: options.dryRun };
  const github = deps.githubApi ?? GITHUB_API;
  const base = deps.routerBase ?? routerBase;

  const { project, target } = await railwayProject(railway, infra.project, { workspaceId: deps.workspaceId, dryRun, log });

  // ── Router ──
  const routerName = hostServiceName(infra.router.name);
  const deployerName = hostServiceName(infra.deployer.name);
  const routerService = project?.services.find((s) => s.name === routerName);
  const routerVars = routerService && project ? await railway.variables(project.id, project.environmentId, routerService.id) : {};
  // Generated once and kept in the router's variables; read back from there after.
  const key = routerVars[ENV.key] ?? (deps.newKey ?? (() => randomBytes(32).toString("hex")))();
  const apps: AppKeys = routerVars[ENV.githubApps] ? JSON.parse(routerVars[ENV.githubApps]) : {};
  const ref = await deps.achqRef();
  const routerSpec = () => routerServiceSpec({ name: routerName, key, apps, deployerUrl: privateUrl(deployerName, DEPLOYER_PORT), ref });

  const routerPlan = await planService(railway, target, routerSpec(), project);
  showChanges(log, routerName, routerPlan.changes);
  let domain = routerPlan.current.domain;
  let routerId = routerPlan.current.serviceId;
  let routerDeployed = false;
  if (!dryRun && routerPlan.changes.length) {
    const applied = await routerPlan.apply();
    ({ domain, serviceId: routerId } = applied);
    routerDeployed = applied.deployed;
  }

  // ── Deployer ──
  const deployerPlan = await planService(
    railway,
    target,
    deployerServiceSpec({
      name: deployerName,
      key,
      routerUrl: privateUrl(routerName, ROUTER_PRIVATE_PORT),
      routerPublicUrl: domain ? base(domain) : undefined,
      owners: infra.deployer.inputs.owners,
      railwayToken: deps.railwayToken,
      projectId: target.projectId ?? "(new)",
      environmentId: target.environmentId ?? "(new)",
      claudeToken: deps.claudeToken,
      ref,
    }),
    project,
  );
  showChanges(log, deployerName, deployerPlan.changes);
  if (!dryRun && deployerPlan.changes.length) await deployerPlan.apply();

  // ── GitHub Apps ──
  const hookUrl = domain ? `${base(domain)}/webhook` : undefined;
  const added = await syncApps(infra.apps, { keys: apps, hookUrl, key, githubApi: github, dryRun, createApp: deps.createApp, log });

  // ── The router again, with the new Apps' keys, straight from memory ──
  if (added) {
    const plan = await planService(railway, target, routerSpec(), await railway.project(target.projectId!));
    showChanges(log, routerName, plan.changes);
    routerDeployed = (await plan.apply()).deployed || routerDeployed;
  }

  // ── Sync ──
  if (!domain) {
    log("  sync: skipped until the router exists");
    return undefined;
  }
  if (routerDeployed) await waitForDeploy(railway, target.environmentId!, routerId!, deps.sleep, log);
  const request: SyncRequest = { prune: options.prune, dryRun };
  return adminRequest<SyncResult>({ base: base(domain), key }, "POST", "/admin/sync", request);
};
