// Installs and loads the plugins a service or container is given, outside core's index, which the config sandbox loads without Bun or node:fs.
import * as fs from "node:fs";
import * as path from "node:path";
import { mergeProviders, type Providers } from "../contracts/providers.ts";
import { PLUGIN } from "../plugin.ts";
import type { Plugin } from "../resources/resource.ts";
import { PluginRef } from "./protocol.ts";

/** Installs the dependencies `dir/package.json` names, into `dir/node_modules`. */
export type Install = (dir: string) => Promise<void>;

/** What was last installed in a plugins dir: installing again only when it changes. */
const INSTALLED = ".installed.json";

const bunInstall: Install = async (dir) => {
  const proc = Bun.spawn(["bun", "install", "--production", "--no-save"], { cwd: dir, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(`Installing the plugins in ${dir} failed`);
};

/** Where a service or container installs its plugins: under its data dir, which outlives a restart or sleep. */
export const pluginsDir = (dataDir: string) => path.join(dataDir, "plugins");

/** `ENV.plugins`'s value, read. */
export const parsePlugins = (json: string): Plugin[] => PluginRef.array().parse(JSON.parse(json));

/**
 * Installs `plugins` in `dir`, if they aren't already, and loads each one's
 * `./providers`. Core is installed beside them at this process's own version,
 * which the plugins' peer ranges were checked against, so the plugins' copy of
 * core is the same code as the process's: Bun installs a peer dependency where
 * it's missing, and `dir` isn't under the process's own install. Each is a
 * bundle, with nothing else to install.
 */
export const loadPlugins = async (plugins: Plugin[], dir: string, { install = bunInstall }: { install?: Install } = {}) => {
  if (!plugins.length) return mergeProviders([]);
  const dependencies = { [PLUGIN.package]: PLUGIN.version, ...Object.fromEntries(plugins.map((p) => [p.package, p.version])) };
  const manifest = `${JSON.stringify({ private: true, dependencies }, null, 2)}\n`;
  const installed = path.join(dir, INSTALLED);
  if (!fs.existsSync(installed) || fs.readFileSync(installed, "utf8") !== manifest) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), manifest);
    await install(dir);
    // Written once it's done, so an interrupted install runs again.
    fs.writeFileSync(installed, manifest);
  }
  const loaded = await Promise.all(
    plugins.map(async (p) => {
      const { providers } = (await import(Bun.resolveSync(`${p.package}/providers`, dir))) as { providers?: Providers };
      if (!providers) throw new Error(`${p.package}@${p.version} has no ./providers export, so achq can't load it as a plugin`);
      return providers;
    }),
  );
  return mergeProviders(loaded);
};

/**
 * Where a config's import of `specifier`, one of `plugins` or core, resolves:
 * to its install in `dir`. Core there is the process's version, and keeps its
 * declarations once per process, so a config declares what the process reads
 * even when the process is bundled with its own copy. With no plugins there's
 * no install, and nothing a config may import.
 */
export const configModules = (plugins: Plugin[], dir: string): Record<string, string> => ({
  ...(plugins.length ? { [PLUGIN.package]: Bun.resolveSync(PLUGIN.package, dir) } : {}),
  ...Object.fromEntries(plugins.map((p) => [p.package, Bun.resolveSync(p.package, dir)])),
});
