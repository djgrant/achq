// Each step reads what exists, prints what would change, then applies it
// unless it's a dry run. Order: Railway project → router → deployer → each App → sync.
import { randomBytes } from "node:crypto";
import { DEPLOYER_PORT, ENV, ROUTER_PRIVATE_PORT, type SyncRequest, type SyncResult } from "@achq/core";
import { appWebhookSecret } from "@achq/core/secrets";
import { appJwt, GITHUB_API, GitHubClient } from "@achq/github/api";
import type { App } from "@achq/github";
import type { ProjectSnapshot, RailwayClient } from "@achq/railway/api";
import { type Change, deployerServiceSpec, formatChange, hostServiceName, planService, privateUrl, routerServiceSpec, type Target } from "@achq/railway/runtime";
import { appSlug, type InfraResources } from "./load.ts";
import { APP_EVENTS, APP_PERMISSIONS, type CreatedApp, type ManifestRequest } from "./manifest.ts";
import { adminRequest, routerBase } from "./router.ts";

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

type Apps = Record<string, { id: string; privateKey: string }>;

const show = (log: UpDeps["log"], subject: string, changes: Change[]) => {
  if (!changes.length) log(`  ${subject}: up to date`);
  for (const c of changes) log(`  ${formatChange(c)}`);
};

export const up = async (infra: InfraResources, options: UpOptions, deps: UpDeps): Promise<SyncResult | undefined> => {
  const { railway, log, dryRun } = { ...deps, dryRun: options.dryRun };
  const github = deps.githubApi ?? GITHUB_API;
  const base = deps.routerBase ?? routerBase;

  // ── Railway project ──
  let project: ProjectSnapshot | undefined;
  const target: Target = {};
  const found = await railway.projectByName(infra.project, deps.workspaceId);
  if (found) {
    project = await railway.project(found.id);
  } else {
    log(`  + railway project ${infra.project}`);
    if (!dryRun) project = await railway.project(await railway.createProject(infra.project, await railway.workspaceId(deps.workspaceId)));
  }
  if (project) Object.assign(target, { projectId: project.id, environmentId: project.environmentId });

  // ── Router ──
  const routerName = hostServiceName(infra.router.name);
  const deployerName = hostServiceName(infra.deployer.name);
  const routerService = project?.services.find((s) => s.name === routerName);
  const routerVars = routerService && project ? await railway.variables(project.id, project.environmentId, routerService.id) : {};
  // Generated once and kept in the router's variables; read back from there after.
  const key = routerVars[ENV.key] ?? (deps.newKey ?? (() => randomBytes(32).toString("hex")))();
  const apps: Apps = routerVars[ENV.githubApps] ? JSON.parse(routerVars[ENV.githubApps]) : {};
  const ref = await deps.achqRef();
  const routerSpec = () => routerServiceSpec({ name: routerName, key, apps, deployerUrl: privateUrl(deployerName, DEPLOYER_PORT), ref });

  const routerPlan = await planService(railway, target, routerSpec(), project);
  show(log, routerName, routerPlan.changes);
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
  show(log, deployerName, deployerPlan.changes);
  if (!dryRun && deployerPlan.changes.length) await deployerPlan.apply();

  // ── GitHub Apps ──
  const hookUrl = domain ? `${base(domain)}/webhook` : undefined;
  let added = false;
  for (const app of infra.apps) {
    const slug = appSlug(app.inputs.name);
    const keys = apps[slug];
    if (!keys) {
      log(`  + github app ${app.inputs.name}${app.inputs.org ? ` (${app.inputs.org})` : ""}: opens GitHub to create it`);
      if (dryRun) continue;
      const created = await deps.createApp({ name: app.inputs.name, org: app.inputs.org, hookUrl: hookUrl! });
      const client = new GitHubClient(`Bearer ${appJwt(created.id, created.pem)}`, github);
      // The secret derives from the App ID, which GitHub only assigns on creation.
      await client.request("PATCH", "/app/hook/config", hookConfig(hookUrl!, key, created.id));
      apps[created.slug] = { id: String(created.id), privateKey: created.pem };
      added = true;
      if (created.slug !== slug) log(`  ! GitHub named it ${created.slug}: set the App's name to "${created.slug}" in the infra`);
      log(`  created ${created.html_url}`);
      continue;
    }
    const client = new GitHubClient(`Bearer ${appJwt(keys.id, keys.privateKey)}`, github);
    const [config, settings] = await Promise.all([
      client.request<{ url?: string; content_type?: string; insecure_ssl?: string }>("GET", "/app/hook/config"),
      client.request<{ events: string[]; permissions: Record<string, string> }>("GET", "/app"),
    ]);
    const changes: Change[] = [];
    if (hookUrl && (config.url !== hookUrl || config.content_type !== "json" || config.insecure_ssl !== "0")) {
      changes.push({ op: "~", target: `${slug} webhook`, detail: `→ ${hookUrl}` });
    }
    show(log, slug, changes);
    for (const problem of appProblems(settings)) log(`  ! ${slug} ${problem}: change it at ${appSettingsUrl(slug, app)}`);
    // GitHub doesn't show the secret, so it's written with the URL rather than compared.
    if (!dryRun && changes.length) await client.request("PATCH", "/app/hook/config", hookConfig(hookUrl!, key, keys.id));
  }

  // ── The router again, with the new Apps' keys, straight from memory ──
  if (added) {
    const plan = await planService(railway, target, routerSpec(), await railway.project(target.projectId!));
    show(log, routerName, plan.changes);
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

const hookConfig = (url: string, key: string, appId: string | number) => ({
  url,
  content_type: "json",
  insecure_ssl: "0",
  secret: appWebhookSecret(key, appId),
});

const RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

/** What the live App lacks of what achq needs. */
export const appProblems = (settings: { events: string[]; permissions: Record<string, string> }) => [
  ...APP_EVENTS.filter((e) => !settings.events.includes(e)).map((e) => `doesn't send ${e}`),
  ...Object.entries(APP_PERMISSIONS)
    .filter(([name, level]) => (RANK[settings.permissions[name]] ?? 0) < RANK[level])
    .map(([name, level]) => `lacks ${name}: ${level}`),
];

const appSettingsUrl = (slug: string, app: App) =>
  app.inputs.org ? `https://github.com/organizations/${app.inputs.org}/settings/apps/${slug}/permissions` : `https://github.com/settings/apps/${slug}/permissions`;

/** Waits for the router's new deploy, so the sync reaches the new config. */
const waitForDeploy = async (railway: RailwayClient, environmentId: string, serviceId: string, sleep: (ms: number) => Promise<void> = Bun.sleep, log: UpDeps["log"]) => {
  log("  waiting for the router to deploy…");
  for (let i = 0; i < 60; i++) {
    const status = (await railway.instance(environmentId, serviceId)).latestDeployment?.status;
    if (status === "SUCCESS") return;
    if (status === "FAILED" || status === "CRASHED") throw new Error(`The router's deploy ${status.toLowerCase()}; see its logs on Railway`);
    await sleep(5000);
  }
  throw new Error("The router hasn't deployed after five minutes");
};

export const formatSync = (result: SyncResult, dryRun: boolean) => {
  const lines: string[] = [];
  const verb = (done: string, would: string) => (dryRun ? would : done);
  if (result.deployed.length) lines.push(`${verb("deployed", "would deploy")}: ${result.deployed.join(", ")}`);
  if (result.uninstalled.length) lines.push(`${verb("uninstalled", "would uninstall")}: ${result.uninstalled.join(", ")}`);
  if (result.pruned.length) lines.push(`${verb("pruned", "would prune")}: ${result.pruned.join(", ")}`);
  for (const f of result.failed) lines.push(`failed: ${f.repo}: ${f.error}`);
  if (result.unchanged.length) lines.push(`unchanged: ${result.unchanged.length} repo${result.unchanged.length === 1 ? "" : "s"}`);
  return lines.length ? lines : ["no repos installed"];
};
