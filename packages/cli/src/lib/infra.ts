import * as path from "node:path";
import { type Check, type Context, Deployer, DEPLOYER_PORT, ENV, type Infra, known, plan, type Resource, Router, ROUTER_PRIVATE_PORT, type SyncRequest, type SyncResult } from "@achq/core";
import { adminSecret } from "@achq/core/secrets";
import { signedFetch } from "@achq/core/signing";
import { collections } from "@achq/utils/collections";
import { crypto } from "@achq/utils/crypto";
import { Env, type Vars } from "@achq/utils/env";
import { HttpError } from "@achq/utils/http";
import { agentEnv, containerProviderNamed, INFRA_MODULES } from "achq/registry";
import { planLines } from "./format.ts";

const SECRET_BYTES = 32;

export type InfraResources = {
  router: Router;
  deployer: Deployer;
  /** Everything the infra declares, the router and deployer among them. */
  resources: Resource[];
};

export type RouterAccess = { base: string; key: string };

export type UpOptions = Required<SyncRequest>;

export type UpDeps = {
  /** What the resources read their settings and credentials from. */
  env: Vars;
  containerEnv: Record<string, string>;
  /** The achq commit the router and deployer run. */
  achqRef: () => Promise<string>;
  /** Opens `url` in your browser to `what`, e.g. to create an App. */
  open: (url: string, what: string) => Promise<void>;
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

/** The router's public URL and AGENT_WEBHOOK_KEY, read from where it runs. Plans the router, so changes nothing. */
export const routerAccess = async ({ router }: InfraResources, ctx: Context) => {
  const planned = await plan([router], ctx);
  const env = planned.value(router.env);
  const url = planned.value(router.url);
  if (!known(env) || !Object.keys(env).length) throw new Error(`There's no router ${router.name}. Run \`achq infra up\`.`);
  const key = env[ENV.key];
  if (!key || !known(url)) throw new Error(`Router ${router.name} isn't set up. Run \`achq infra up\`.`);
  return { base: url, key };
};

/** Throws on anything but 2xx. */
export const adminRequest = async <T>(router: RouterAccess, method: string, path: string, body?: unknown): Promise<T> => {
  const res = await signedFetch(adminSecret(router.key), router.base + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, method, path, text, "Router");
  return (text ? JSON.parse(text) : undefined) as T;
};

export const up = async ({ router, deployer, resources }: InfraResources, options: UpOptions, deps: UpDeps) => {
  const { log } = deps;
  const ctx = cliContext({ env: deps.env, log, open: deps.open, newSecret: deps.newSecret, sleep: deps.sleep });
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

  // A new router's URL is only known once it's made.
  const read = options.dryRun ? planned : await planned.apply();
  const url = read.value(router.url);
  const key = read.value(router.key);
  if (!known(url) || !known(key)) {
    log("  sync: skipped until the router exists");
    return undefined;
  }
  const base = deps.routerUrl ? deps.routerUrl(url) : url;
  return adminRequest<SyncResult>({ base, key }, "POST", "/admin/sync", options);
};
