import * as fs from "node:fs";
import * as path from "node:path";
import type { RepoManifest } from "@achq/core";
import { evaluateConfig } from "@achq/deployer/config";
import { readTree } from "@achq/utils/fs";

const CONFIG_DIR = ".achq";
const CONFIG_ENTRY = "config.ts";
/** Installed packages under `.achq/` are not part of the config. */
const SKIPPED_DIRS = ["node_modules"];

const assertHasConfig = (repoDir: string, dir: string) => {
  if (!fs.existsSync(path.join(dir, CONFIG_ENTRY))) throw new Error(`No ${CONFIG_DIR}/${CONFIG_ENTRY} in ${repoDir}`);
};

/** Every file under `.achq/`, by path relative to it. */
export const readConfigFiles = (repoDir: string) => {
  const dir = path.join(repoDir, CONFIG_DIR);
  assertHasConfig(repoDir, dir);
  return readTree(dir, { skip: SKIPPED_DIRS });
};

/** The repo's manifest, evaluated in the sandbox as the deployer does it. */
export const loadRepoManifest = async (repoDir: string): Promise<RepoManifest> => evaluateConfig(readConfigFiles(repoDir));
