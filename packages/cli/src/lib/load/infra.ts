import * as path from "node:path";
import { Deployer, type Infra, type Resource, Router } from "@achq/core";
import { collections } from "@achq/utils/collections";
import { containerProviderNamed } from "achq/registry";
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

const ONE_EACH = "The infra must declare one router and one deployer";

const ofClass = <T extends Resource>(resources: Resource[], type: abstract new (...args: any[]) => T) => resources.filter((r): r is T => r instanceof type);

/** The router and deployer have to reach each other over their container provider's private network. */
const assertShareContainerProvider = (router: Router, deployer: Deployer) => {
  if (router.containerProvider === deployer.containerProvider) return;
  throw new Error(`The router runs on ${router.containerProvider} and the deployer on ${deployer.containerProvider}; they must share a container provider`);
};

/** The deployer puts containers on its own container provider, so achq has to know it. Throws if not. */
const assertKnownContainerProvider = (deployer: Deployer) => void containerProviderNamed(deployer.containerProvider);

/** The router a resource's inputs name, if any. Resources only share `inputs` by convention, so this looks rather than assumes. */
const routerInput = (r: Resource): unknown => (r as { inputs?: { router?: unknown } }).inputs?.router;

/** The deployer, and every other resource that names a router, use the infra's. */
const assertSharesRouter = (resources: Resource[], router: Router, deployer: Deployer) => {
  if (deployer.inputs.router !== router) throw new Error(`Deployer ${deployer.name} must use router ${router.name}`);
  for (const r of resources) {
    if (r === deployer) continue;
    const named = routerInput(r);
    if (named instanceof Router && named !== router) throw new Error(`${r.kind} ${r.name} must use router ${router.name}`);
  }
};

/** The infra's router and deployer, checked against each other and everything else it declares. */
export const checkInfra = ({ resources }: Infra): InfraResources => {
  const router = collections.only(ofClass(resources, Router));
  const deployer = collections.only(ofClass(resources, Deployer));
  if (!router || !deployer) throw new Error(ONE_EACH);
  assertShareContainerProvider(router, deployer);
  assertKnownContainerProvider(deployer);
  assertSharesRouter(resources, router, deployer);
  return { router, deployer, resources };
};
