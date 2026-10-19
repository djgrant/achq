import { defineCommand } from "@pokit/core";
import { clean } from "../lib/errors.ts";
import { z } from "zod";
import { ACHQ_SOURCE } from "@achq/core";
import { agentEnv, codeHostProviderNamed } from "achq/registry";
import { ACHQ_CODE_PATHS, INFRA_FILE } from "../constants.ts";
import { openInBrowser } from "../lib/browser.ts";
import { need, secretEnv } from "../lib/env.ts";
import { loadInfra } from "../lib/load/infra.ts";
import { formatSync } from "../lib/up/format.ts";
import { up } from "../lib/up/up.ts";
import { infraFile } from "../lib/workdir.ts";

export const command = defineCommand({
  label: "Bring the ACHQ infra in line with achq.infra.ts",
  examples: ["achq up --dry-run", "achq up", "achq up --prune"],
  context: {
    prune: { from: "flag", schema: z.boolean().default(false), description: "Delete the containers and volumes of repos no longer installed" },
    dryRun: { from: "flag", schema: z.boolean().default(false), description: "Show what would change, and change nothing" },
  },
  run: clean(async (_r, { context }) => {
    const file = infraFile();
    if (!file) throw new Error(`Run this in the ACHQ infra repo, which has ${INFRA_FILE} at its root`);
    const infra = await loadInfra(file);
    const source = codeHostProviderNamed(ACHQ_SOURCE.host).create(process.env);
    const result = await up(infra, { prune: context.prune, dryRun: context.dryRun }, {
      env: secretEnv(),
      containerEnv: Object.fromEntries(agentEnv().map(({ name, hint }) => [name, need(name, hint)])),
      achqRef: () => source.lastCommit(ACHQ_SOURCE.repo, ACHQ_SOURCE.branch, ACHQ_CODE_PATHS),
      open: async (url, what) => {
        console.log(`  opening ${url} to ${what}…`);
        await openInBrowser(url);
      },
      log: (line) => console.log(line),
    });
    if (result) for (const line of formatSync(result, context.dryRun)) console.log(`  sync: ${line}`);
  }),
});
