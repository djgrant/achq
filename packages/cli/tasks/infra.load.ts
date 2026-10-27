import * as path from "node:path";
import { defineTask } from "@pokit/core";
import { type CodeHost, type Deployer, type Infra, isCodeHost, isDeployer, isRouter, isAgentRuntime, type Resource, type Router, type AgentRuntime } from "@achq/core";
import { collections } from "@achq/utils/collections";
import * as v from "valibot";

export type InfraResources = {
  router: Router;
  deployer: Deployer;
  /** Where the repos it serves live: an infra has one. */
  codeHost: CodeHost;
  /** The agent runtimes its containers can run. */
  runtimes: AgentRuntime[];
  /** Everything the infra declares, the router and deployer among them. */
  resources: Resource[];
};

/**
 * Runs the infra file's default export and checks what it declares. Its
 * imports resolve as any module's do, to what the infra repo installed: core
 * and its plugins, whose copy of core needn't be achq's own, as core
 * recognises its classes whichever copy made them.
 */
export const loadInfra = async (file: string) => {
  const mod = await import(path.resolve(file));
  if (typeof mod.default !== "function") throw new Error(`${file} must \`export default achq(() => { … })\``);
  return checkInfra(mod.default() as Infra);
};

/** The infra's router, deployer, code host and runtimes, checked against each other and everything else it declares. */
export const checkInfra = ({ resources }: Infra) => {
  const router = collections.only(resources.filter(isRouter));
  const deployer = collections.only(resources.filter(isDeployer));
  if (!router || !deployer) throw new Error("The infra must declare one router and one deployer");
  // They reach each other through what their container provider offers: a private network, or its own routing.
  if (router.containerProvider !== deployer.containerProvider) {
    throw new Error(`The router runs on ${router.containerProvider} and the deployer on ${deployer.containerProvider}; they must share a container provider`);
  }
  if (deployer.inputs.router !== router) throw new Error(`Deployer ${deployer.name} must use router ${router.name}`);
  for (const r of resources) {
    // Resources only share `inputs` by convention, so this looks for a router rather than assumes one.
    const named = (r as { inputs?: { router?: unknown } }).inputs?.router;
    if (r !== deployer && isRouter(named) && named !== router) throw new Error(`${r.kind} ${r.name} must use router ${router.name}`);
  }
  const codeHost = collections.only(resources.filter(isCodeHost));
  if (!codeHost) throw new Error("The infra must declare one code host, e.g. `new github.CodeHost(\"github\")`");
  const runtimes = resources.filter(isAgentRuntime);
  for (const [i, runtime] of runtimes.entries()) {
    const other = runtimes.slice(0, i).find((r) => r.id === runtime.id);
    if (other) throw new Error(`Runtimes ${other.name} and ${runtime.name} are both ${runtime.id}: declare each runtime once`);
  }
  return { router, deployer, codeHost, runtimes, resources };
};

/** The infra the file declares, checked: every infra command starts here. Its checks load it too, as they run before the command. */
export const infraLoad = defineTask({
  label: "Load the infra",
  params: v.object({ file: v.string() }),
  run: (_r, { params }) => loadInfra(params.file),
});
