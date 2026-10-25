import * as fs from "node:fs";
import * as path from "node:path";
import { defineTask } from "@pokit/core";
import { CONFIG_DIR, CONFIG_ENTRY } from "@achq/core";
import { evaluateConfig } from "@achq/deployer/config";
import { disk } from "@achq/utils/disk";
import { z } from "zod";

/** Installed packages under `.achq/` are not part of the config. */
const SKIPPED_DIRS = ["node_modules"];

/** The repo's manifest, evaluated in the sandbox as the deployer does it, from every file under its `.achq/`. */
export const repoEvaluateManifest = defineTask({
  label: "Evaluate the repo's config",
  params: z.object({ dir: z.string() }),
  run: async (_r, { params: { dir: repoDir } }) => {
    const dir = path.join(repoDir, CONFIG_DIR);
    if (!fs.existsSync(path.join(dir, CONFIG_ENTRY))) throw new Error(`No ${CONFIG_DIR}/${CONFIG_ENTRY} in ${repoDir}`);
    return evaluateConfig(disk.readTree(dir, { skip: SKIPPED_DIRS }));
  },
});
