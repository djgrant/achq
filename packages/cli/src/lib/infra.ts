import * as path from "node:path";
import { type Check, type Context, Deployer, type Vault, DEPLOYER_PORT, ENV, type Infra, type JobStarted, type JobStatus, known, plan, type Resource, Router, ROUTER_PRIVATE_PORT, type SyncRequest, type DeployerVersion, type SyncStatus, teardown, type TeardownRequest, type TeardownResult } from "@achq/core";
import { adminSecret } from "@achq/core/secrets";
import { signedFetch } from "@achq/core/signing";
import { async } from "@achq/utils/async";
import { collections } from "@achq/utils/collections";
import { crypto } from "@achq/utils/crypto";
import { Env, type Vars } from "@achq/utils/env";
import { HttpError } from "@achq/utils/http";
import { agentEnv, containerProviderNamed, INFRA_MODULES, vaultProviderNamed } from "achq/registry";
import { DEPLOYER_VERSION_TIMEOUT_MS, SYNC_INTERVAL_MS, SYNC_TIMEOUT_MS, TEARDOWN_TIMEOUT_MS } from "../constants.ts";
import type { CliConfig } from "./config.ts";
import { planLines } from "./format.ts";

const SECRET_BYTES = 32;

export type InfraResources = {
  router: Router;
  deployer: Deployer;
  /** Everything the infra declares, the router and deployer among them. */
  resources: Resource[];
};

export type RouterAccess = { base: string; key: string };

/** The sync's options, and whether to replace the deployer's own token, where it has one. */
export type UpOptions = Required<SyncRequest> & { rotateDeployerToken?: boolean };

export type UpDeps = {
  /** What the resources read their settings and credentials from. */
  env: Vars;
  containerEnv: Record<string, string>;
  /** The achq commit the router and deployer run. */
  achqRef: () => Promise<string>;
  /** Opens `url` in your browser to `what`, e.g. to create an App. */
  open: (url: string, what: string) => Promise<void>;
  /** Asks you for a secret without echoing it, e.g. a token you made in the browser. */
  prompt?: (message: string) => Promise<string>;
  /** Where it keeps secrets it makes for reuse, e.g. Apps' keys, if `achq.config.ts` names one. */
  vault?: Vault;
  /** Rewrites the router's public URL for the sync; tests point it at a fake. */
  routerUrl?: (publicUrl: string) => string;
  log: (line: string) => void;
  newSecret?: () => string;
  sleep?: (ms: number) => Promise<void>;
};

/** What planning and applying get from the CLI. Tests pass their own secrets and sleep; parts left undefined keep the CLI's. */
export const cliContext = (parts: Pick<Context, "env" | "log"> & Partial<Context>): Context => ({
  ...parts,
  newSecret: parts.newSecret ?? (() => crypto.randomHex(SECRET_BYTES)),
  sleep: parts.sleep ?? ((ms) => Bun.sleep(ms)),
});

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

/** The router's public URL and AGENT_WEBHOOK_KEY, read from where it runs, or undefined if it isn't there. Plans the router, so changes nothing. */
const foundRouter = async ({ router }: InfraResources, ctx: Context): Promise<RouterAccess | undefined> => {
  const planned = await plan([router], ctx);
  const env = planned.value(router.env);
  const url = planned.value(router.url);
  if (!known(env) || !Object.keys(env).length) return undefined;
  const key = env[ENV.key];
  if (!key || !known(url)) throw new Error(`Router ${router.name} isn't set up. Run \`achq infra up\`.`);
  return { base: url, key };
};

/** As `foundRouter`, but throws if it isn't there. */
export const routerAccess = async (infra: InfraResources, ctx: Context) => {
  const found = await foundRouter(infra, ctx);
  if (!found) throw new Error(`There's no router ${infra.router.name}. Run \`achq infra up\`.`);
  return found;
};

/** Throws on anything but 2xx. */
export const adminRequest = async <T>(router: RouterAccess, method: string, path: string, body?: unknown): Promise<T> => {
  const res = await signedFetch(adminSecret(router.key), router.base + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, method, path, text, "Router");
  return (text ? JSON.parse(text) : undefined) as T;
};

/** Waits until the deployer runs `ref`. One older than `GET /version` answers 404, which counts as not yet. */
const deployerRuns = async (router: RouterAccess, ref: string, ctx: Context, log: (line: string) => void) => {
  const running = () => adminRequest<DeployerVersion>(router, "GET", "/admin/deployer").then((v) => v.ref, () => undefined);
  if ((await running()) === ref) return;
  log(`  waiting for the deployer to run ${ref.slice(0, 7)}…`);
  const found = await async.pollUntil(running, (r) => r === ref, { intervalMs: SYNC_INTERVAL_MS, timeoutMs: DEPLOYER_VERSION_TIMEOUT_MS, sleep: ctx.sleep });
  if (found !== ref) throw new Error(`The deployer isn't running ${ref.slice(0, 7)} after ${DEPLOYER_VERSION_TIMEOUT_MS / 60_000} minutes; see its logs on its container provider`);
};

export const up = async ({ router, deployer, resources }: InfraResources, options: UpOptions, deps: UpDeps) => {
  const { log } = deps;
  const ctx = cliContext({ env: deps.env, log, open: deps.open, prompt: deps.prompt, vault: deps.vault, newSecret: deps.newSecret, sleep: deps.sleep });
  if (options.rotateDeployerToken) deployer.rotateToken();
  // What achq itself gives the router and deployer: how they reach each other, and what they run.
  const ref = await deps.achqRef();
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
    [ENV.containerEnv]: JSON.stringify(deps.containerEnv),
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
  const base = deps.routerUrl ? deps.routerUrl(url) : url;
  // A new deployer takes a while to replace the one running, and a sync the old one ran would deploy with what it was given.
  if (!options.dryRun) await deployerRuns({ base, key }, ref, ctx, log);
  const sync: SyncRequest = { prune: options.prune, dryRun: options.dryRun };
  const status = await deployerJob<SyncStatus>({ base, key }, "sync", sync, SYNC_TIMEOUT_MS, ctx);
  if (!status) throw new Error(`The sync hasn't finished after ${SYNC_TIMEOUT_MS / 60_000} minutes; \`achq infra status\` shows each repo's deploy`);
  if (status.state !== "done") throw new Error("The sync failed; the deployer's logs say why");
  return status.result;
};

/** Starts a job on the deployer, e.g. `sync`, and asks after it until it's done: it can outlast a request. Undefined if it's still running after `timeoutMs`. */
const deployerJob = async <S extends JobStatus<unknown>>(router: RouterAccess, job: string, request: unknown, timeoutMs: number, ctx: Context) => {
  const { id } = await adminRequest<JobStarted>(router, "POST", `/admin/${job}`, request);
  return async.pollUntil(
    () => adminRequest<S>(router, "GET", `/admin/${job}/${id}`),
    (s) => s.state !== "running",
    { intervalMs: SYNC_INTERVAL_MS, timeoutMs, sleep: ctx.sleep },
  );
};

export type DownDeps = {
  env: Vars;
  /** Asks you whether to go ahead, once it's shown what it deletes. */
  confirm: (message: string) => Promise<boolean>;
  vault?: Vault;
  /** Rewrites the router's public URL; tests point it at a fake. */
  routerUrl?: (publicUrl: string) => string;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
};

/** The containers the deployer deletes, or would: none without a router. */
const deleteContainers = async (router: RouterAccess | undefined, dryRun: boolean, ctx: Context) => {
  if (!router) return [];
  const request: TeardownRequest = { dryRun };
  const status = await deployerJob<JobStatus<TeardownResult>>(router, "teardown", request, TEARDOWN_TIMEOUT_MS, ctx);
  if (!status) throw new Error(`The deployer hasn't deleted the containers after ${TEARDOWN_TIMEOUT_MS / 60_000} minutes; nothing else was deleted`);
  if (status.state !== "done") throw new Error("The deployer couldn't delete the containers, and nothing else was deleted; its logs say why");
  return status.result.removed;
};

/**
 * Deletes the infra: first every container, by the deployer, then the router,
 * the deployer and what they share, each before what it depends on. Shows it
 * all and asks first. What's protected is listed, and left.
 */
export const down = async (infra: InfraResources, { dryRun }: { dryRun: boolean }, deps: DownDeps) => {
  const { log } = deps;
  const ctx = cliContext({ env: deps.env, log, vault: deps.vault, sleep: deps.sleep });
  const found = await foundRouter(infra, ctx);
  const router = found && { ...found, base: deps.routerUrl ? deps.routerUrl(found.base) : found.base };
  const containers = await deleteContainers(router, true, ctx);
  const planned = await teardown(infra.resources, ctx);
  const changes = [...containers.map((c) => ({ op: "-" as const, target: c, what: "container" })), ...planned.changes];
  if (!changes.length) log("  nothing to delete");
  for (const line of planLines({ changes, warnings: [], protected: planned.protected })) log(`  ${line}`);
  if (!dryRun && changes.length) {
    if (!(await deps.confirm("Delete all of this?"))) throw new Error("Nothing was deleted");
    await deleteContainers(router, false, ctx);
    await planned.apply();
    log("  deleted");
  }
};
