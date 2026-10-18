// The container runs its own repo's config natively, at the commit the router
// was given, for the parts that can be code (agent settings).
//
// `.achq/` comes from the bare mirror (`git archive` after a fetch) rather than
// GitHub's contents API: the mirror is already there for worktrees and is
// fetched with the agents' credentials, so this needs no extra permission or
// API client, and a commit already fetched loads offline (as `resume` needs).
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, collectPlan, registered, resetRegistry, type RepoPlan } from "../core/resources.ts";
import { extractTree, hasCommit } from "./repo.ts";

/** Where achq is installed: what a config's `achq` and `achq/github` imports resolve to. */
export const ACHQ_ROOT = path.resolve(import.meta.dir, "..", "..");

export type LoadedConfig = {
  commit: string;
  /** The extracted `.achq/` directory: paths in the config are relative to it. */
  root: string;
  plan: RepoPlan;
  /** The live Agent objects, with their config as code evaluated. */
  agents: Agent[];
};

export type ConfigLoaderOptions = {
  mirror: string;
  /** `paths.config(commit)`: where each commit's `.achq/` and bundle go. */
  dir: (commit: string) => string;
  /** Fetches the mirror, for a commit it doesn't have yet. */
  fetch: () => Promise<void>;
  achqRoot?: string;
};

/** Bundles `.achq/config.ts`, refusing imports other than `achq`, `achq/github` and files in `.achq/`. */
export const bundleConfig = async (root: string, outdir: string, achqRoot = ACHQ_ROOT) => {
  const entry = path.join(root, "config.ts");
  if (!fs.existsSync(entry)) throw new Error("There's no .achq/config.ts");
  const modules: Record<string, string> = {
    achq: path.join(achqRoot, "src", "index.ts"),
    "achq/github": path.join(achqRoot, "src", "github", "index.ts"),
  };
  const real = fs.realpathSync(root);
  const result = await Bun.build({
    entrypoints: [entry],
    outdir,
    target: "bun",
    format: "esm",
    plugins: [
      {
        name: "achq-config",
        setup(build) {
          // achq stays external, so the config registers its resources in the
          // same module instance the runner reads them from.
          build.onResolve({ filter: /^[^./]/ }, (args) => {
            const target = modules[args.path];
            if (!target) throw new Error(`.achq/ can only import achq, achq/github and its own files, not "${args.path}"`);
            return { path: target, external: true };
          });
          build.onResolve({ filter: /^\.\.?\// }, (args) => {
            const file = path.resolve(path.dirname(fs.realpathSync(args.importer)), args.path);
            if (!file.startsWith(real + path.sep)) throw new Error(`.achq/ can only import its own files, not "${args.path}"`);
            return undefined;
          });
        },
      },
    ],
  });
  if (!result.success) throw new AggregateError(result.logs, "Bundling .achq/config.ts failed");
  const bundle = result.outputs[0]!.path;
  // Builtins (`node:fs`, `bun`) skip resolve plugins, so check what the bundle still imports.
  const allowed = new Set(Object.values(modules));
  const imports = new Bun.Transpiler({ loader: "js" }).scanImports(fs.readFileSync(bundle, "utf8"));
  const refused = imports.map((i) => i.path).filter((p) => !allowed.has(p));
  if (refused.length) throw new Error(`.achq/ can only import achq, achq/github and its own files, not ${refused.map((p) => `"${p}"`).join(", ")}`);
  return bundle;
};

let evaluating: Promise<unknown> = Promise.resolve();

/** Imports a bundle into a fresh registry. One at a time, since the registry is shared. */
export const evaluateBundle = (bundle: string): Promise<{ plan: RepoPlan; agents: Agent[] }> => {
  const run = evaluating.then(async () => {
    resetRegistry();
    try {
      await import(bundle);
      const resources = registered();
      return { plan: collectPlan(resources), agents: resources.filter((r): r is Agent => r instanceof Agent) };
    } finally {
      resetRegistry();
    }
  });
  evaluating = run.catch(() => {});
  return run;
};

/** `loadConfig(commit)`, cached per commit. */
export const createConfigLoader = (opts: ConfigLoaderOptions) => {
  const cache = new Map<string, Promise<LoadedConfig>>();
  let loads = 0;

  const load = async (commit: string): Promise<LoadedConfig> => {
    if (!(await hasCommit(opts.mirror, commit))) await opts.fetch();
    if (!(await hasCommit(opts.mirror, commit))) throw new Error(`Commit ${commit} isn't in the repo`);
    const dir = opts.dir(commit);
    fs.rmSync(dir, { recursive: true, force: true });
    await extractTree(opts.mirror, commit, ".achq", path.join(dir, "tree"));
    const root = path.join(dir, "tree", ".achq");
    // A new directory per load: a module path that was imported before would come from the module cache.
    const bundle = await bundleConfig(root, path.join(dir, `bundle-${++loads}`), opts.achqRoot);
    return { commit, root, ...(await evaluateBundle(bundle)) };
  };

  return (commit: string): Promise<LoadedConfig> => {
    let loaded = cache.get(commit);
    if (!loaded) {
      loaded = load(commit);
      cache.set(commit, loaded);
      loaded.catch(() => cache.delete(commit));
    }
    return loaded;
  };
};
