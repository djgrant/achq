import { defineCommand } from "@pokit/core";
import { ACHQ_SOURCE } from "@achq/core";
import { Env } from "@achq/utils/env";
import { subprocess } from "@achq/utils/subprocess";
import { agentEnv, codeHostProviderNamed } from "achq/registry";
import { z } from "zod";
import { ACHQ_CODE_PATHS } from "../constants.ts";
import { formatSync } from "../lib/format.ts";
import { loadInfra, up } from "../lib/infra.ts";
import { clean } from "../lib/terminal.ts";
import { needInfra } from "../lib/workdir.ts";

export const command = defineCommand({
  label: "Deploy the infra",
  examples: ["achq infra up --dry-run", "achq infra up", "achq infra up --prune"],
  context: {
    prune: { from: "flag", schema: z.boolean().default(false), description: "Delete uninstalled repos' containers" },
    dryRun: { from: "flag", schema: z.boolean().default(false), description: "Preview changes" },
  },
  run: clean(async (_r, { context }) => {
    const infra = await loadInfra(needInfra());
    // Where the router and deployer's code comes from: achq's own repo, on its code host.
    const source = codeHostProviderNamed(ACHQ_SOURCE.host).create(process.env);
    const env = new Env(process.env);
    const result = await up(infra, { prune: context.prune, dryRun: context.dryRun }, {
      env: process.env,
      // What every container gets: each agent runtime's variables, from your shell.
      containerEnv: Object.fromEntries(agentEnv().map(({ name, hint }) => [name, env.require(name, hint)])),
      achqRef: () => source.lastCommit(ACHQ_SOURCE.repo, ACHQ_SOURCE.branch, ACHQ_CODE_PATHS),
      open: async (url, what) => {
        console.log(`  opening ${url} to ${what}…`);
        subprocess.openUrl(url);
      },
      log: (line) => console.log(line),
    });
    if (result) for (const line of formatSync(result, context.dryRun)) console.log(`  sync: ${line}`);
  }),
});
