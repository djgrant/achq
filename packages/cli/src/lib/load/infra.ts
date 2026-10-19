import * as path from "node:path";
import { Deployer, type Infra, type Resource, Router } from "@achq/core";
import { containerHostNamed } from "achq/registry";
import { registerModules } from "./modules.ts";

export type InfraResources = {
  router: Router;
  deployer: Deployer;
  /** Everything the infra declares, the router and deployer among them. */
  resources: Resource[];
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
  if (routers.length !== 1 || deployers.length !== 1) throw new Error("The infra must declare one router and one deployer");
  const [router, deployer] = [routers[0]!, deployers[0]!];
  // The router, deployer and containers reach each other over their container host's private network.
  if (router.containerHost !== deployer.containerHost) throw new Error(`The router runs on ${router.containerHost} and the deployer on ${deployer.containerHost}; they must share a container host`);
  // The deployer puts containers on its own container host.
  containerHostNamed(deployer.containerHost);
  if (deployer.inputs.router !== router) throw new Error(`Deployer ${deployer.name} must use router ${router.name}`);
  for (const r of infra.resources) {
    const inputs = (r as { inputs?: { router?: unknown; deployer?: unknown } }).inputs;
    if (r === deployer || !inputs) continue;
    if (inputs.router instanceof Router && inputs.router !== router) throw new Error(`${r.kind} ${r.name} must use router ${router.name}`);
    if (inputs.deployer instanceof Deployer && inputs.deployer !== deployer) throw new Error(`${r.kind} ${r.name} must use deployer ${deployer.name}`);
  }
  return { router, deployer, resources: infra.resources };
};
