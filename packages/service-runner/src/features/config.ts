import * as fs from "node:fs";
import * as path from "node:path";
import { type Agent, CONFIG_DIR, CONFIG_ENTRY, collectManifest, declared, isAgent, resetDeclarations } from "@achq/core";
import { type RepoManifest, validateManifest } from "@achq/core/manifest";
import { async } from "@achq/utils/async";
import { disk } from "@achq/utils/disk";
import { CONFIG_MODULES } from "@achq/registry/modules";
import { extractTree, hasCommit } from "./repo.ts";

const MODULES = Object.fromEntries(CONFIG_MODULES.map((specifier) => [specifier, Bun.resolveSync(specifier, import.meta.dir)]));
const ALLOWED = `${CONFIG_MODULES.join(", ")} and its own files`;
const BARE_IMPORT = /^[^./]/;
const RELATIVE_IMPORT = /^\.\.?\//;

export type LoadedConfig = {
  commit: string;
  /** Paths in the config are relative to it. */
  root: string;
  manifest: RepoManifest;
  agents: Agent[];
};

export type ConfigLoaderOptions = {
  mirror: string;
  /** `paths.config(commit)`: where each commit's `.achq/` and bundle go. */
  dir: (commit: string) => string;
  fetch: () => Promise<void>;
};

/** A path in `.achq/`, refusing anything that leaves it. */
export const inRoot = (root: string, relative: string) => {
  const file = disk.resolveWithin(root, relative);
  if (!file) throw new Error(`${relative} is outside ${CONFIG_DIR}/`);
  return file;
};

/** Bundles `.achq/config.ts`, refusing imports other than CONFIG_MODULES and files in `.achq/`. */
export const bundleConfig = async (root: string, outdir: string) => {
  const entry = path.join(root, CONFIG_ENTRY);
  if (!fs.existsSync(entry)) throw new Error(`There's no ${CONFIG_DIR}/${CONFIG_ENTRY}`);
  const realRoot = fs.realpathSync(root);
  const result = await Bun.build({
    entrypoints: [entry],
    outdir,
    target: "bun",
    format: "esm",
    plugins: [
      {
        name: "achq-config",
        setup(build) {
          // achq stays external, so the config declares its resources in the
          // same module instance the runner reads them from.
          build.onResolve({ filter: BARE_IMPORT }, (args) => {
            const target = MODULES[args.path];
            if (!target) throw new Error(`${CONFIG_DIR}/ can only import ${ALLOWED}, not "${args.path}"`);
            return { path: target, external: true };
          });
          build.onResolve({ filter: RELATIVE_IMPORT }, (args) => {
            const file = path.resolve(path.dirname(fs.realpathSync(args.importer)), args.path);
            if (!disk.isWithin(realRoot, file)) throw new Error(`${CONFIG_DIR}/ can only import its own files, not "${args.path}"`);
            return undefined;
          });
        },
      },
    ],
  });
  if (!result.success) throw new AggregateError(result.logs, `Bundling ${CONFIG_DIR}/${CONFIG_ENTRY} failed`);
  const bundle = result.outputs[0]!.path;
  // Builtins (`node:fs`, `bun`) skip resolve plugins, so check what the bundle still imports.
  const allowed = new Set(Object.values(MODULES));
  const imports = new Bun.Transpiler({ loader: "js" }).scanImports(fs.readFileSync(bundle, "utf8"));
  const refused = imports.map((i) => i.path).filter((p) => !allowed.has(p));
  if (refused.length) throw new Error(`${CONFIG_DIR}/ can only import ${ALLOWED}, not ${refused.map((p) => `"${p}"`).join(", ")}`);
  return bundle;
};

/** Declarations are shared module state, so one evaluation at a time. */
const oneAtATime = async.serial();

export const evaluateBundle = (bundle: string) =>
  oneAtATime(async () => {
    resetDeclarations();
    try {
      await import(bundle);
      const resources = declared();
      return { manifest: validateManifest(collectManifest(resources)), agents: resources.filter(isAgent) };
    } finally {
      resetDeclarations();
    }
  });

/** Loads in this process, by any loader: each gets its own bundle path. */
let loads = 0;

/** Cached per commit. A failed load is tried again next time. */
export const createConfigLoader = (opts: ConfigLoaderOptions) =>
  async.memo(async (commit: string): Promise<LoadedConfig> => {
    // Fetches only for a commit the mirror doesn't have, so a known commit loads offline.
    if (!(await hasCommit(opts.mirror, commit))) {
      await opts.fetch();
      if (!(await hasCommit(opts.mirror, commit))) throw new Error(`Commit ${commit} isn't in the repo`);
    }
    const dir = opts.dir(commit);
    const tree = path.join(dir, "tree");
    fs.rmSync(dir, { recursive: true, force: true });
    // From the mirror, not the code host's API: it's already fetched with the agents' credentials, and works offline.
    await extractTree(opts.mirror, commit, CONFIG_DIR, tree);
    const root = path.join(tree, CONFIG_DIR);
    // A new directory per load, because a path imported before would come from the module cache.
    const bundle = await bundleConfig(root, path.join(dir, `bundle-${++loads}`));
    return { commit, root, ...(await evaluateBundle(bundle)) };
  });
