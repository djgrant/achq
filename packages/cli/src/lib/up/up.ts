import { type Deployer, DEPLOYER_PORT, ENV, known, plan, type Router, ROUTER_PRIVATE_PORT, type SyncRequest, type SyncResult } from "@achq/core";
import { cliContext } from "../context.ts";
import type { InfraResources } from "../load/infra.ts";
import { adminRequest } from "../router.ts";
import { planLines } from "../changes.ts";

export type UpOptions = { prune: boolean; dryRun: boolean };

export type UpDeps = {
  /** What the resources read their settings and credentials from. */
  env: Record<string, string | undefined>;
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

/** The variables achq itself gives the router and deployer: how they reach each other, and what they run. */
const declareAchqVariables = (router: Router, deployer: Deployer, ref: string, containerEnv: Record<string, string>) => {
  router.variables({
    [ENV.deployerUrl]: deployer.privateUrl(DEPLOYER_PORT),
    [ENV.ref]: ref,
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
};

export const up = async ({ router, deployer, resources }: InfraResources, options: UpOptions, deps: UpDeps): Promise<SyncResult | undefined> => {
  const { log } = deps;
  const ctx = cliContext({ env: deps.env, log, open: deps.open, newSecret: deps.newSecret, sleep: deps.sleep });
  declareAchqVariables(router, deployer, await deps.achqRef(), deps.containerEnv);

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
  const request: SyncRequest = { prune: options.prune, dryRun: options.dryRun };
  const base = deps.routerUrl ? deps.routerUrl(url) : url;
  return adminRequest<SyncResult>({ base, key }, "POST", "/admin/sync", request);
};
