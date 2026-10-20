import { defineCommand } from "@pokit/core";
import { clean } from "../lib/errors.ts";
import { z } from "zod";
import { ACHQ_SOURCE } from "@achq/core";
import { agentEnv, codeHostProviderNamed } from "achq/registry";
import { ACHQ_CODE_PATHS } from "../constants.ts";
import { openInBrowser } from "../lib/browser.ts";
import { need } from "../lib/env.ts";
import { loadInfra } from "../lib/load/infra.ts";
import { formatSync } from "../lib/up/format.ts";
import { up } from "../lib/up/up.ts";
import { needInfra } from "../lib/workdir.ts";

/** What every container gets: each agent runtime's variables, from your shell. */
const containerEnvFromShell = () => Object.fromEntries(agentEnv().map(({ name, hint }) => [name, need(name, hint)]));

/** Where the router and deployer's code comes from: achq's own repo, on its code host. */
const achqSource = () => codeHostProviderNamed(ACHQ_SOURCE.host).create(process.env);

export const command = defineCommand({
  label: "Deploy the infra",
  examples: ["achq infra up --dry-run", "achq infra up", "achq infra up --prune"],
  context: {
    prune: { from: "flag", schema: z.boolean().default(false), description: "Delete uninstalled repos' containers" },
    dryRun: { from: "flag", schema: z.boolean().default(false), description: "Preview changes" },
  },
  run: clean(async (_r, { context }) => {
    const file = needInfra();
    const infra = await loadInfra(file);
    const source = achqSource();
    const result = await up(infra, { prune: context.prune, dryRun: context.dryRun }, {
      env: process.env,
      containerEnv: containerEnvFromShell(),
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
