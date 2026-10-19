import * as fs from "node:fs";
import * as path from "node:path";
import { collectPlan, type RepoPlan, resetRegistry } from "@achq/core";
import { evaluateConfig } from "@achq/deployer/config";
import { registerModules } from "./modules.ts";

let loads = 0;

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

/** The channels the config's threads and events come from. */
export const channelsOf = (plan: RepoPlan) => [...new Set([...plan.workspaces.map((w) => w.threads.channel), ...plan.triggers.map((t) => t.event.channel)])];
