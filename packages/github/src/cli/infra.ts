import type { Deployer, ProviderInfra, Resource, Router } from "@achq/core";
import { GITHUB_ENV } from "../constants.ts";
import { App } from "../resources/app.ts";
import { type AppKeys, parseApps } from "../runtime/app-keys.ts";
import { appSlug } from "./app-slug.ts";
import { syncApps } from "./apps.ts";

/** Stable JSON, so the same Apps always make the same variable. */
export const appsVariable = (apps: AppKeys) => JSON.stringify(Object.fromEntries(Object.entries(apps).sort(([a], [b]) => a.localeCompare(b))));

const checkApps = (all: Resource[], { router, deployer }: { router: Router; deployer: Deployer }) => {
  const apps = all.filter((r): r is App => r instanceof App);
  for (const app of apps) {
    if (app.inputs.router !== router || app.inputs.deployer !== deployer) throw new Error(`App ${app.name} must use router ${router.name} and deployer ${deployer.name}`);
  }
  const slugs = apps.map((a) => appSlug(a.inputs.name));
  const dupe = slugs.find((s, i) => slugs.indexOf(s) !== i);
  if (dupe) throw new Error(`Two Apps are named ${dupe}`);
  return apps;
};

/** The infra's Apps. Their keys live only in the router's ACHQ_GITHUB_APPS. */
export const githubInfra = (urls: { api: string; web: string }): ProviderInfra => ({
  resources: checkApps,
  routerEnv: (current) => ({ [GITHUB_ENV.apps]: appsVariable(parseApps(current[GITHUB_ENV.apps])) }),
  async up(resources, step) {
    const keys = parseApps(step.current[GITHUB_ENV.apps]);
    await syncApps(resources as App[], keys, step, urls);
    return { [GITHUB_ENV.apps]: appsVariable(keys) };
  },
});
