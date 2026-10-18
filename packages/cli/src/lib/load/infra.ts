import * as path from "node:path";
import { Deployer, type Infra, type Resource, Router } from "@achq/core";
import { App } from "@achq/github";
import { appSlug } from "@achq/github/runtime";
import { registerModules } from "./modules.ts";

export type InfraResources = {
  resources: Resource[];
  router: Router;
  deployer: Deployer;
  apps: App[];
};

/** Runs the infra file's default export and checks what it declares. */
export const loadInfra = async (file: string): Promise<InfraResources> => {
  registerModules();
  const mod = await import(path.resolve(file));
  if (typeof mod.default !== "function") throw new Error(`${file} must \`export default achq(() => { … })\``);
  return checkInfra(mod.default() as Infra);
};

/** What holds whatever platforms the infra uses. Each platform checks its own resources when `up` expands them. */
export const checkInfra = (infra: Infra): InfraResources => {
  const routers = infra.resources.filter((r): r is Router => r instanceof Router);
  const deployers = infra.resources.filter((r): r is Deployer => r instanceof Deployer);
  const apps = infra.resources.filter((r): r is App => r instanceof App);
  if (routers.length !== 1 || deployers.length !== 1) throw new Error("The infra must declare one router and one deployer");
  const [router, deployer] = [routers[0]!, deployers[0]!];
  if (deployer.inputs.router !== router) throw new Error(`Deployer ${deployer.name} must use router ${router.name}`);
  for (const app of apps) {
    if (app.inputs.router !== router || app.inputs.deployer !== deployer) throw new Error(`App ${app.name} must use router ${router.name} and deployer ${deployer.name}`);
  }
  const slugs = apps.map((a) => appSlug(a.inputs.name));
  const dupe = slugs.find((s, i) => slugs.indexOf(s) !== i);
  if (dupe) throw new Error(`Two Apps are named ${dupe}`);
  return { resources: infra.resources, router, deployer, apps };
};
