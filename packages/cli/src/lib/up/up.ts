// The infra's resources as one plan: it reads everything and prints what would
// change, applying makes it (the router's deploy waits until it's live), then
// the router syncs the deployer's repos.
//
// The infra declares where the router and deployer run and what else they
// serve (e.g. GitHub Apps, which declare their own variables on the router);
// this declares the variables achq itself gives them.
import { DEPLOYER_PORT, ENV, known, plan, ROUTER_PRIVATE_PORT, type SyncRequest, type SyncResult } from "@achq/core";
import { cliContext } from "../context.ts";
import type { InfraResources } from "../load/infra.ts";
import { adminRequest } from "../router.ts";
import { formatChange } from "./format.ts";

export type UpOptions = { prune: boolean; dryRun: boolean };

export type UpDeps = {
  /** What the resources read their settings and credentials from. */
  env: Record<string, string | undefined>;
  /** What every container gets: the agent runtimes' variables. */
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

export const up = async ({ router, deployer, resources }: InfraResources, options: UpOptions, deps: UpDeps): Promise<SyncResult | undefined> => {
  const { log } = deps;
  const ctx = cliContext({ env: deps.env, log, open: deps.open, ...(deps.newSecret && { newSecret: deps.newSecret }), ...(deps.sleep && { sleep: deps.sleep }) });
  const ref = await deps.achqRef();

  router.variables({
    [ENV.deployerUrl]: deployer.privateUrl(DEPLOYER_PORT),
    [ENV.ref]: ref,
    [ENV.privatePort]: String(ROUTER_PRIVATE_PORT),
  });
  deployer.variables({
    [ENV.key]: router.key,
    [ENV.routerUrl]: router.privateUrl(ROUTER_PRIVATE_PORT),
    [ENV.routerPublicUrl]: router.url,
    [ENV.owners]: deployer.inputs.owners.join(","),
    [ENV.containerEnv]: JSON.stringify(deps.containerEnv),
    [ENV.ref]: ref,
    [ENV.platform]: deployer.platform,
  });

  const planned = await plan(resources, ctx);
  if (!planned.changes.length) log("  up to date");
  for (const c of planned.changes) log(`  ${formatChange(c)}`);
  for (const w of planned.warnings) log(`  ! ${w}`);

  // A new router's URL is only known once it's made.
  const read = options.dryRun ? planned : await planned.apply();
  const url = read.value(router.url);
  const key = read.value(router.key);
  if (!known(url) || !known(key)) {
    log("  sync: skipped until the router exists");
    return undefined;
  }
  const request: SyncRequest = { prune: options.prune, dryRun: options.dryRun };
  return adminRequest<SyncResult>({ base: deps.routerUrl ? deps.routerUrl(url) : url, key }, "POST", "/admin/sync", request);
};
