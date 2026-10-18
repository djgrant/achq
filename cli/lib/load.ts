// Loading the ACHQ infra and a repo's config locally, with Bun. `achq`,
// `achq/github` and `achq/railway` resolve to this checkout's modules, so the
// resources they declare are the same classes the CLI checks against.
import * as fs from "node:fs";
import * as path from "node:path";
import * as achq from "../../src/index.ts";
import * as github from "../../src/github/index.ts";
import * as railway from "../../src/railway/index.ts";
import { Deployer, type Infra, Router } from "../../src/core/infra.ts";
import { collectPlan, type RepoPlan, resetRegistry } from "../../src/core/resources.ts";
import { App } from "../../src/github/resources.ts";
import { RailwayDeployerHost, RailwayRouterHost } from "../../src/railway/hosts.ts";

let registered = false;
let loads = 0;
const registerModules = () => {
  if (registered) return;
  registered = true;
  const modules: Record<string, object> = { achq, "achq/github": github, "achq/railway": railway };
  Bun.plugin({
    name: "achq",
    setup(build) {
      for (const [specifier, exports] of Object.entries(modules)) build.module(specifier, () => ({ exports: { ...exports }, loader: "object" }));
    },
  });
};

export type InfraResources = {
  router: Router & { inputs: { host: RailwayRouterHost } };
  deployer: Deployer & { inputs: { host: RailwayDeployerHost } };
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
  if (!(router.inputs.host instanceof RailwayRouterHost) || !(deployer.inputs.host instanceof RailwayDeployerHost)) {
    throw new Error("Only Railway routers and deployers are supported: use railway.Router and railway.Deployer");
  }
  const project = router.inputs.host.project;
  const containerProject = (deployer.inputs.containerHost as { project?: unknown }).project;
  if (deployer.inputs.host.project !== project || deployer.inputs.containerHost.platform !== "railway" || containerProject !== project) {
    throw new Error(`The router, deployer and containers must share one Railway project (${project}), for its private network`);
  }
  if (deployer.inputs.router !== router) throw new Error(`Deployer ${deployer.name} must use router ${router.name}`);
  for (const app of apps) {
    if (app.inputs.router !== router || app.inputs.deployer !== deployer) throw new Error(`App ${app.name} must use router ${router.name} and deployer ${deployer.name}`);
  }
  const slugs = apps.map((a) => appSlug(a.inputs.name));
  const dupe = slugs.find((s, i) => slugs.indexOf(s) !== i);
  if (dupe) throw new Error(`Two Apps are named ${dupe}`);
  return { router: router as InfraResources["router"], deployer: deployer as InfraResources["deployer"], apps, project };
};

/** The slug GitHub gives an App with this name. */
export const appSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Every file under `.achq/`, by path relative to it. */
export const readConfigFiles = (repoDir: string) => {
  const dir = path.join(repoDir, ".achq");
  if (!fs.existsSync(path.join(dir, "config.ts"))) throw new Error(`No .achq/config.ts in ${repoDir}`);
  const files: Record<string, string> = {};
  const walk = (sub: string) => {
    for (const entry of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = path.join(sub, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(rel);
      } else if (entry.isFile()) files[rel] = fs.readFileSync(path.join(dir, rel), "utf8");
    }
  };
  walk("");
  return files;
};

/**
 * The repo's plan. With the sandbox (`src/sandbox`, when present) it's
 * evaluated as the deployer would; otherwise it's imported with Bun, which is
 * fine here since it's your own checkout.
 */
export const loadRepoPlan = async (repoDir: string, options: { sandbox?: boolean } = {}): Promise<RepoPlan> => {
  const files = readConfigFiles(repoDir);
  const sandboxFile = path.join(import.meta.dir, "../../src/sandbox/index.ts");
  const sandbox = options.sandbox !== false && fs.existsSync(sandboxFile) ? await import(sandboxFile) : undefined;
  if (typeof sandbox?.evaluateConfig === "function") return sandbox.evaluateConfig(files);
  registerModules();
  resetRegistry();
  // A fresh query string makes Bun evaluate it again; a cached module wouldn't register anything.
  await import(`${path.join(repoDir, ".achq", "config.ts")}?load=${++loads}`);
  return collectPlan();
};
