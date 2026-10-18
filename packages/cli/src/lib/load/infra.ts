import * as path from "node:path";
import { Deployer, type Infra, type Platform, type ProviderInfra, type Resource, Router } from "@achq/core";
import { platformNamed, PROVIDERS } from "achq/registry";
import { registerModules } from "./modules.ts";

type Env = Record<string, string | undefined>;

export type InfraResources = {
  router: Router;
  deployer: Deployer;
  /** The platform the router and deployer run on. */
  platform: Platform;
  /** Each provider with an infra part, and its resources among the infra's. */
  providers: { id: string; infra: ProviderInfra; resources: Resource[] }[];
};

/** Runs the infra file's default export and checks what it declares. */
export const loadInfra = async (file: string, env: Env = process.env): Promise<InfraResources> => {
  registerModules();
  const mod = await import(path.resolve(file));
  if (typeof mod.default !== "function") throw new Error(`${file} must \`export default achq(() => { … })\``);
  return checkInfra(mod.default() as Infra, env);
};

export const checkInfra = (infra: Infra, env: Env = process.env): InfraResources => {
  const routers = infra.resources.filter((r): r is Router => r instanceof Router);
  const deployers = infra.resources.filter((r): r is Deployer => r instanceof Deployer);
  if (routers.length !== 1 || deployers.length !== 1) throw new Error("The infra must declare one router and one deployer");
  const [router, deployer] = [routers[0], deployers[0]];
  if (router.platform !== deployer.platform) throw new Error(`The router runs on ${router.platform} and the deployer on ${deployer.platform}; they must share a platform`);
  const platform = platformNamed(router.platform);
  if (deployer.inputs.router !== router) throw new Error(`Deployer ${deployer.name} must use router ${router.name}`);
  const providers = PROVIDERS.flatMap((p) => {
    if (!p.infra) return [];
    const part = p.infra(env);
    return [{ id: p.id, infra: part, resources: part.resources(infra.resources, { router, deployer }) }];
  });
  return { router, deployer, platform, providers };
};
