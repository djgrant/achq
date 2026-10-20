// The container runs its repo's config natively, at the commit the router
// forwarded, for the parts that are code (agent settings).
//
// `.achq/` comes from the bare mirror rather than the code host's API. The
// mirror is already there for worktrees and is fetched with the agents'
// credentials, so no extra permission or API client is needed. A commit
// already fetched also loads offline, which `resume` needs.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Agent, RepoManifest } from "@achq/core";
import { memoAsync } from "@achq/utils/async";
import { CONFIG_DIR } from "../constants.ts";
import { extractTree, hasCommit } from "../repo.ts";
import { bundleConfig } from "./bundle.ts";
import { evaluateBundle } from "./evaluate.ts";

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

/** Cached per commit. A failed load is tried again next time. */
export const createConfigLoader = (opts: ConfigLoaderOptions): ((commit: string) => Promise<LoadedConfig>) => {
  let loads = 0;

  /** Fetches only for a commit the mirror doesn't have, so a known commit loads offline. */
  const ensureCommit = async (commit: string) => {
    if (await hasCommit(opts.mirror, commit)) return;
    await opts.fetch();
    if (!(await hasCommit(opts.mirror, commit))) throw new Error(`Commit ${commit} isn't in the repo`);
  };

  const load = async (commit: string): Promise<LoadedConfig> => {
    await ensureCommit(commit);
    const dir = opts.dir(commit);
    const tree = path.join(dir, "tree");
    fs.rmSync(dir, { recursive: true, force: true });
    await extractTree(opts.mirror, commit, CONFIG_DIR, tree);
    const root = path.join(tree, CONFIG_DIR);
    // A new directory per load, because a path imported before would come from the module cache.
    const bundle = await bundleConfig(root, path.join(dir, `bundle-${++loads}`));
    return { commit, root, ...(await evaluateBundle(bundle)) };
  };

  return memoAsync(load);
};
