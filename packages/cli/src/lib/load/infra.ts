import * as path from "node:path";
import { Deployer, type Infra, type Platform, Router } from "@achq/core";
import { App } from "@achq/github";
import { appSlug } from "../app-slug.ts";
import { platformNamed } from "../platforms.ts";
import { registerModules } from "./modules.ts";

export type InfraResources = {
  router: Router;
  deployer: Deployer;
  apps: App[];
  /** The platform the router and deployer run on. */
  platform: Platform;
};

/** Runs the infra file's default export and checks what it declares. */
export const loadInfra = async (file: string): Promise<InfraResources> => {
  registerModules();
  const mod = await import(path.resolve(file));
  if (typeof mod.default !== "function") throw new Error(`${file} must \`export default achq(() => { … })\``);
  return checkInfra(mod.default() as Infra);
};

export const checkInfra = (infra: Infra): InfraResources => {
  const routers = infra.resources.filter((r): r is Router => r instanceof Router);
  const deployers = infra.resources.filter((r): r is Deployer => r instanceof Deployer);
  const apps = infra.resources.filter((r): r is App => r instanceof App);
  if (routers.length !== 1 || deployers.length !== 1) throw new Error("The infra must declare one router and one deployer");
  const [router, deployer] = [routers[0], deployers[0]];
  if (router.platform !== deployer.platform) throw new Error(`The router runs on ${router.platform} and the deployer on ${deployer.platform}; they must share a platform`);
  const platform = platformNamed(router.platform);
  if (deployer.inputs.router !== router) throw new Error(`Deployer ${deployer.name} must use router ${router.name}`);
  for (const app of apps) {
    if (app.inputs.router !== router || app.inputs.deployer !== deployer) throw new Error(`App ${app.name} must use router ${router.name} and deployer ${deployer.name}`);
  }
  const slugs = apps.map((a) => appSlug(a.inputs.name));
  const dupe = slugs.find((s, i) => slugs.indexOf(s) !== i);
  if (dupe) throw new Error(`Two Apps are named ${dupe}`);
  return { router, deployer, apps, platform };
};
