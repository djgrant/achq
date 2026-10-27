import * as fs from "node:fs";
import * as path from "node:path";
import { defineTask } from "@pokit/core";
import { CONFIG_DIR, CONFIG_ENTRY, CORE_PLUGIN } from "@achq/core";
import { type ConfigModules, evaluateConfig } from "@achq/deployer/config";
import { disk } from "@achq/utils/disk";
import * as v from "valibot";

/** Installed packages under `.achq/` are not part of the config. */
const SKIPPED_DIRS = ["node_modules"];

/** A package's own name, without a subpath: what a config may import a plugin by. */
const PACKAGE_NAME = /^(@[^/]+\/)?[^/@.:][^/]*$/;

const LOADERS = { ts: "ts", mts: "ts", tsx: "tsx", js: "js", mjs: "js" } as const;

const resolveFrom = (specifier: string, dirs: string[]) => {
  for (const dir of dirs) {
    try {
      return Bun.resolveSync(specifier, dir);
    } catch {}
  }
};

/**
 * What the config may import, as the deployer would allow it: core, and each
 * plugin it imports, found where the repo installed it or else beside achq.
 * A plugin is a package with a `./providers` export; anything else is left
 * out, so the sandbox refuses it as the deployer's would.
 */
const configModules = (files: Record<string, string>, repoDir: string): ConfigModules => {
  const dirs = [repoDir, import.meta.dir];
  const imported = new Set<string>();
  for (const [file, contents] of Object.entries(files)) {
    const loader = LOADERS[path.extname(file).slice(1) as keyof typeof LOADERS];
    if (!loader) continue;
    for (const { path: specifier } of new Bun.Transpiler({ loader }).scanImports(contents)) if (PACKAGE_NAME.test(specifier)) imported.add(specifier);
  }
  const modules: ConfigModules = { [CORE_PLUGIN.package]: resolveFrom(CORE_PLUGIN.package, dirs)! };
  for (const specifier of imported) {
    const entry = resolveFrom(specifier, dirs);
    if (entry && resolveFrom(`${specifier}/providers`, dirs)) modules[specifier] = entry;
  }
  return modules;
};

/** The repo's manifest, evaluated in the sandbox as the deployer does it, from every file under its `.achq/`. */
export const repoEvaluateManifest = defineTask({
  label: "Evaluate the repo's config",
  params: v.object({ dir: v.string() }),
  run: async (_r, { params: { dir: repoDir } }) => {
    const dir = path.join(repoDir, CONFIG_DIR);
    if (!fs.existsSync(path.join(dir, CONFIG_ENTRY))) throw new Error(`No ${CONFIG_DIR}/${CONFIG_ENTRY} in ${repoDir}`);
    const files = disk.readTree(dir, { skip: SKIPPED_DIRS });
    return evaluateConfig(files, configModules(files, repoDir));
  },
});
