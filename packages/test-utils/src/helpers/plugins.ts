import * as fs from "node:fs";
import * as path from "node:path";
import type { Install } from "@achq/core/plugins";

/** This checkout's packages, each directory by its package's name. */
const PACKAGES = path.join(import.meta.dir, "..", "..", "..");
const workspace = () =>
  Object.fromEntries(
    fs.readdirSync(PACKAGES).flatMap((dir) => {
      const file = path.join(PACKAGES, dir, "package.json");
      return fs.existsSync(file) ? [[JSON.parse(fs.readFileSync(file, "utf8")).name as string, path.join(PACKAGES, dir)]] : [];
    }),
  );

/** Installs a plugins dir as `bun install` would, but offline: each dependency it names is linked to this checkout's package. */
export const linkWorkspace: Install = async (dir) => {
  const packages = workspace();
  const { dependencies } = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  for (const name of Object.keys(dependencies)) {
    const target = packages[name];
    if (!target) throw new Error(`No package ${name} in this checkout to install`);
    const link = path.join(dir, "node_modules", name);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.rmSync(link, { force: true });
    fs.symlinkSync(target, link);
  }
};

/** The plugins every container gets in tests, as the deployer passes them on in ACHQ_PLUGINS. */
export const CONTAINER_PLUGINS = [
  { package: "@achq/github", version: "0.1.0" },
  { package: "@achq/claude", version: "0.1.0" },
];

/** A checkout package's entry module: its `.` export. */
const entryOf = (dir: string) => path.join(dir, JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).exports["."]);

/** What a config may import in tests: core and the first-party container plugins, from this checkout. */
export const workspaceConfigModules = () => {
  const packages = workspace();
  return Object.fromEntries(["@achq/core", ...CONTAINER_PLUGINS.map((p) => p.package)].map((name) => [name, entryOf(packages[name]!)]));
};
