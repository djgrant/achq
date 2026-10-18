// The container runs its repo's config natively, at the commit the router
// forwarded, for the parts that are code (agent settings).
//
// `.achq/` comes from the bare mirror rather than the repo host's API. The
// mirror is already there for worktrees and is fetched with the agents'
// credentials, so no extra permission or API client is needed. A commit
// already fetched also loads offline, which `resume` needs.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Agent, RepoPlan } from "@achq/core";
import { CONFIG_DIR } from "../constants.ts";
import { extractTree, hasCommit } from "../repo.ts";
import { bundleConfig } from "./bundle.ts";
import { evaluateBundle } from "./evaluate.ts";

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
    await extractTree(opts.mirror, commit, CONFIG_DIR, path.join(dir, "tree"));
    const root = path.join(dir, "tree", CONFIG_DIR);
    // A new directory per load, because a path imported before would come from the module cache.
    const bundle = await bundleConfig(root, path.join(dir, `bundle-${++loads}`));
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
