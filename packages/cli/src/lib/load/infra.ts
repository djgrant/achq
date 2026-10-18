import * as path from "node:path";
import * as railway from "achq/railway";
import { Deployer, type Infra, Router } from "@achq/core";
import { App } from "@achq/github";
import { appSlug } from "../app-slug.ts";
import { registerModules } from "./modules.ts";

export type InfraResources = {
  router: railway.Router;
  deployer: railway.Deployer;
  apps: App[];
  /** The Railway project the router, deployer and containers share. */
  project: string;
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
  if (!(router instanceof railway.Router) || !(deployer instanceof railway.Deployer)) {
    throw new Error("Only Railway routers and deployers are supported: use railway.Router and railway.Deployer");
  }
  const project = router.inputs.project;
  if (deployer.inputs.project !== project) {
    throw new Error(`The router and deployer must share one Railway project (${project}), for its private network`);
  }
  if (deployer.inputs.router !== router) throw new Error(`Deployer ${deployer.name} must use router ${router.name}`);
  for (const app of apps) {
    if (app.inputs.router !== router || app.inputs.deployer !== deployer) throw new Error(`App ${app.name} must use router ${router.name} and deployer ${deployer.name}`);
  }
  const slugs = apps.map((a) => appSlug(a.inputs.name));
  const dupe = slugs.find((s, i) => slugs.indexOf(s) !== i);
  if (dupe) throw new Error(`Two Apps are named ${dupe}`);
  return { router, deployer, apps, project };
};
