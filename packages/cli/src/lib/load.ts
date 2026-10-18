// `achq`, `achq/github` and `achq/railway` imports resolve to this checkout's
// modules. That way the resources a config declares are the same classes the
// CLI's `instanceof` checks use.
import * as fs from "node:fs";
import * as path from "node:path";
import * as achq from "achq";
import * as github from "achq/github";
import * as railway from "achq/railway";
import { Deployer, type Infra, Router, collectPlan, type RepoPlan, resetRegistry } from "@achq/core";
import { evaluateConfig } from "@achq/deployer/config";
import { App } from "@achq/github";

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
 * The repo's plan, evaluated in the sandbox as the deployer does it.
 * `sandbox: false` imports it with Bun instead. That's safe because it's your own checkout.
 */
export const loadRepoPlan = async (repoDir: string, options: { sandbox?: boolean } = {}): Promise<RepoPlan> => {
  const files = readConfigFiles(repoDir);
  if (options.sandbox !== false) return evaluateConfig(files);
  registerModules();
  resetRegistry();
  // A cached module wouldn't register anything, so a fresh query string makes Bun evaluate it again.
  await import(`${path.join(repoDir, ".achq", "config.ts")}?load=${++loads}`);
  return collectPlan();
};
