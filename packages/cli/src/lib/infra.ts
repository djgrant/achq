import * as path from "node:path";
import { type Check, type Context, Deployer, DEPLOYER_PORT, ENV, type Infra, known, plan, type Resource, Router, ROUTER_PRIVATE_PORT, type SyncRequest, type SyncResult, teardown } from "@achq/core";
import { context } from "@achq/core/context";
import { routerAdmin, type RouterAdmin } from "@achq/core/client";
import { async } from "@achq/utils/async";
import { collections } from "@achq/utils/collections";
import { Env, type Vars } from "@achq/utils/env";
import { HttpError } from "@achq/utils/http";
import { agentEnv, containerProviderNamed, INFRA_MODULES, vaultProviderNamed } from "achq/registry";
import { DEPLOYER_VERSION_TIMEOUT_MS, SYNC_INTERVAL_MS, SYNC_TIMEOUT_MS } from "../constants.ts";
import type { CliConfig } from "./config.ts";
import { formatSync, planLines } from "./format.ts";

const NOT_FOUND = 404;

export type InfraResources = {
  router: Router;
  deployer: Deployer;
  /** Everything the infra declares, the router and deployer among them. */
  resources: Resource[];
};

/** What `routerAdmin` reaches the router with: its public URL and AGENT_WEBHOOK_KEY. */
export type RouterAccess = { url: string; key: string };

/** The sync's options, and whether to replace the deployer's own token, where it has one. */
export type UpOptions = Required<Pick<SyncRequest, "prune" | "dryRun">> & { rotateDeployerToken?: boolean };

/** What planning and applying get from the CLI, as a Context's parts, and what else `up` needs. Parts left undefined keep the CLI's. */
export type UpDeps = Pick<Context, "env" | "log"> & Partial<Context> & {
  containerEnv: Record<string, string>;
  /** The achq commit the router and deployer run. */
  achqRef: () => Promise<string>;
  /** Opens `url` in your browser to `what`, e.g. to create an App. */
  open: (url: string, what: string) => Promise<void>;
  /** Rewrites the router's public URL for the sync; tests point it at a fake. */
  routerUrl?: (publicUrl: string) => string;
};

let modulesRegistered = false;

/** Runs the infra file's default export and checks what it declares. */
export const loadInfra = async (file: string) => {
  // Its `achq/infra` imports are this checkout's modules, so what it declares is made of the classes achq knows.
  if (!modulesRegistered) {
    modulesRegistered = true;
    Bun.plugin({
      name: "achq",
      setup(build) {
        for (const [specifier, exports] of Object.entries(INFRA_MODULES)) build.module(specifier, () => ({ exports: { ...exports }, loader: "object" }));
      },
    });
  }
  const mod = await import(path.resolve(file));
  if (typeof mod.default !== "function") throw new Error(`${file} must \`export default achq(() => { … })\``);
  return checkInfra(mod.default() as Infra);
};

/** The infra's router and deployer, checked against each other and everything else it declares. */
export const checkInfra = ({ resources }: Infra): InfraResources => {
  const router = collections.only(resources.filter((r) => r instanceof Router));
  const deployer = collections.only(resources.filter((r) => r instanceof Deployer));
  if (!router || !deployer) throw new Error("The infra must declare one router and one deployer");
  // They reach each other through what their container provider offers: a private network, or its own routing.
  if (router.containerProvider !== deployer.containerProvider) {
    throw new Error(`The router runs on ${router.containerProvider} and the deployer on ${deployer.containerProvider}; they must share a container provider`);
  }
  // The deployer puts containers on its own container provider, so achq has to know it: this throws if it doesn't.
  containerProviderNamed(deployer.containerProvider);
  if (deployer.inputs.router !== router) throw new Error(`Deployer ${deployer.name} must use router ${router.name}`);
  for (const r of resources) {
    // Resources only share `inputs` by convention, so this looks for a router rather than assumes one.
    const named = (r as { inputs?: { router?: unknown } }).inputs?.router;
    if (r !== deployer && named instanceof Router && named !== router) throw new Error(`${r.kind} ${r.name} must use router ${router.name}`);
  }
  return { router, deployer, resources };
};

/** The vault `achq.config.ts` names, if it names one. */
export const configVault = (config: Pick<CliConfig, "vault"> | undefined, env: Vars) =>
  config?.vault ? vaultProviderNamed(config.vault.provider).create(env).vault(config.vault.name) : undefined;

/** What to make sure of before reaching the infra in `file`: what its container provider checks, e.g. that Railway takes your token. */
export const infraChecks = async (file: string, env: Vars) => {
  const { deployer } = await loadInfra(file);
  return containerProviderNamed(deployer.containerProvider).checks?.(env) ?? [];
};

/** That `env` has what every container gets from it: each agent runtime's variables. */
export const agentEnvCheck = (env: Vars): Check => ({
  label: "Agent variables",
  check: async () => {
    for (const { name, hint } of agentEnv()) new Env(env).require(name, hint);
  },
});

/**
 * The router's public URL and AGENT_WEBHOOK_KEY, read from where it runs, or
 * undefined if it hasn't both: one without its key never reached the deployer,
 * so nothing was deployed through it. Plans the router, so changes nothing.
 */
const foundRouter = async ({ router }: InfraResources, ctx: Context): Promise<RouterAccess | undefined> => {
  const planned = await plan([router], ctx);
  const env = planned.value(router.env);
  const url = planned.value(router.url);
  const key = known(env) ? env[ENV.key] : undefined;
  return key && known(url) ? { url, key } : undefined;
};

/** As `foundRouter`, but throws if it isn't there. */
export const routerAccess = async (infra: InfraResources, ctx: Context) => {
  const found = await foundRouter(infra, ctx);
  if (!found) throw new Error(`There's no router ${infra.router.name}. Run \`achq infra up\`.`);
  return found;
};

/** Waits until the deployer runs `ref`. One older than `GET /version` answers 404, which counts as not yet. */
const deployerRuns = async (admin: RouterAdmin, ref: string, ctx: Context, log: (line: string) => void) => {
  const running = () => admin.deployerVersion().then((v) => v.ref, () => undefined);
  if ((await running()) === ref) return;
  log(`  waiting for the deployer to run ${ref.slice(0, 7)}…`);
  const found = await async.pollUntil(running, (r) => r === ref, { intervalMs: SYNC_INTERVAL_MS, timeoutMs: DEPLOYER_VERSION_TIMEOUT_MS, sleep: ctx.sleep });
  if (found !== ref) throw new Error(`The deployer isn't running ${ref.slice(0, 7)} after ${DEPLOYER_VERSION_TIMEOUT_MS / 60_000} minutes; see its logs on its container provider`);
};

export const up = async ({ router, deployer, resources }: InfraResources, options: UpOptions, deps: UpDeps) => {
  const { containerEnv, achqRef, routerUrl, ...parts } = deps;
  const { log } = parts;
  const ctx = context(parts);
  if (options.rotateDeployerToken) deployer.rotateToken();
  // What achq itself gives the router and deployer: how they reach each other, and what they run.
  const ref = await achqRef();
  router.variables({
    [ENV.deployerUrl]: deployer.privateUrl(DEPLOYER_PORT),
    [ENV.ref]: ref,
    // Where it keeps what it stores: its container provider's store.
    [ENV.containerProvider]: router.containerProvider,
  });
  deployer.variables({
    [ENV.key]: router.key,
    [ENV.routerUrl]: router.privateUrl(ROUTER_PRIVATE_PORT),
    [ENV.routerPublicUrl]: router.url,
    [ENV.owners]: deployer.inputs.owners.join(","),
    [ENV.containerEnv]: JSON.stringify(containerEnv),
    [ENV.ref]: ref,
    [ENV.containerProvider]: deployer.containerProvider,
  });

  const planned = await plan(resources, ctx);
  if (!planned.changes.length) log("  up to date");
  for (const line of planLines(planned)) log(`  ${line}`);

  // On some providers a new router's URL is known before it's made, so a dry run asks whether the router exists: it has variables.
  const read = options.dryRun ? planned : await planned.apply();
  const url = read.value(router.url);
  const key = read.value(router.key);
  const existing = planned.value(router.env);
  const exists = !options.dryRun || (known(existing) && Object.keys(existing).length > 0);
  if (!known(url) || !known(key) || !exists) {
    log("  sync: skipped until the router exists");
    return undefined;
  }
  const admin = routerAdmin({ url: routerUrl ? routerUrl(url) : url, key });
  // A new deployer takes a while to replace the one running, and a sync the old one ran would deploy with what it was given.
  if (!options.dryRun) await deployerRuns(admin, ref, ctx, log);
  return sync(admin, { prune: options.prune, dryRun: options.dryRun }, ctx);
};

/**
 * Has the deployer sync, and asks after it until it's done: it can outlast a
 * request. A sync the deployer lost, restarting, is started again: syncing
 * twice changes nothing more than once.
 */
const sync = async (admin: RouterAdmin, request: SyncRequest, ctx: Context): Promise<SyncResult> => {
  const start = () => admin.sync(request).then(({ id }) => id);
  let id = await start();
  const status = await async.pollUntil(
    async () => {
      try {
        return await admin.syncStatus(id);
      } catch (e) {
        if (!(e instanceof HttpError && e.status === NOT_FOUND)) throw e;
        id = await start();
        return { state: "running" } as const;
      }
    },
    (s) => s.state !== "running",
    { intervalMs: SYNC_INTERVAL_MS, timeoutMs: SYNC_TIMEOUT_MS, sleep: ctx.sleep },
  );
  if (!status) throw new Error(`The sync hasn't finished after ${SYNC_TIMEOUT_MS / 60_000} minutes; \`achq infra status\` shows each repo's deploy`);
  if (status.state !== "done") throw new Error("The sync failed; the deployer's logs say why");
  return status.result;
};

/** What planning and applying get from the CLI, as a Context's parts, and what else `down` needs. Parts left undefined keep the CLI's. */
export type DownDeps = Pick<Context, "env" | "log"> & Partial<Context> & {
  /** Asks you whether to go ahead, once it's shown what it deletes. */
  confirm: (message: string) => Promise<boolean>;
  /** Opens `url` in your browser to `what`: where you delete what's protected yourself. */
  open: (url: string, what: string) => Promise<void>;
  /** Rewrites the router's public URL; tests point it at a fake. */
  routerUrl?: (publicUrl: string) => string;
};

/**
 * Deletes the infra: first the deployer syncs to no repos, uninstalling each
 * and deleting every container, then the router, the deployer and what they
 * share are deleted, each before what it depends on. Shows it all and asks
 * first, then deletes only what it showed. What's protected is listed and
 * left, and where you delete each yourself is opened.
 */
export const down = async (infra: InfraResources, { dryRun }: { dryRun: boolean }, deps: DownDeps) => {
  const { confirm, open, routerUrl, ...parts } = deps;
  const { log } = parts;
  // Teardown opens nothing itself: where you delete what's protected is opened once the rest is deleted.
  const ctx = context(parts);
  const found = await foundRouter(infra, ctx);
  const router = found && routerAdmin({ url: routerUrl ? routerUrl(found.url) : found.url, key: found.key });
  const request: SyncRequest = { empty: true, prune: true };
  const synced = router && (await sync(router, { ...request, dryRun: true }, ctx));
  const planned = await teardown(infra.resources, ctx);
  const nothing = !planned.changes.length && !synced?.uninstalled.length && !synced?.pruned.length;
  if (nothing) log("  nothing to delete");
  // In the order it happens.
  if (synced && !nothing) for (const line of formatSync(synced, true)) log(`  sync: ${line}`);
  for (const line of planLines({ ...planned, warnings: [] })) log(`  ${line}`);
  if (dryRun) return;
  if (!nothing) {
    if (!(await confirm("Delete all of this?"))) throw new Error("Nothing was deleted");
    if (router) for (const line of formatSync(await sync(router, { ...request, expect: synced!.pruned }, ctx), false)) log(`  sync: ${line}`);
    await planned.apply();
    log("  deleted");
  }
  for (const { target, page } of planned.protected) if (page) await open(page, `delete ${target}`);
};
