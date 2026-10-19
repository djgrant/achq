import * as fs from "node:fs";
import * as path from "node:path";
import type { RepoPlan } from "@achq/core";
import { evaluateConfig } from "@achq/deployer/config";

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

/** The repo's plan, evaluated in the sandbox as the deployer does it. */
export const loadRepoPlan = async (repoDir: string): Promise<RepoPlan> => evaluateConfig(readConfigFiles(repoDir));

/** The channels the config's threads and events come from. */
export const channelsOf = (plan: RepoPlan) => [...new Set([...plan.workspaces.map((w) => w.threads.channel), ...plan.triggers.map((t) => t.event.channel)])];
