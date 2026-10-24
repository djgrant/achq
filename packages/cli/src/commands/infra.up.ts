import { defineCommand } from "@pokit/core";
import { ACHQ_SOURCE } from "@achq/core";
import { Env } from "@achq/utils/env";
import { agentEnv, CODE_HOST } from "achq/registry";
import { z } from "zod";
import { ACHQ_CODE_PATHS } from "../constants.ts";
import { formatSync } from "../lib/format.ts";
import { loadConfig } from "../lib/config.ts";
import { agentEnvCheck, configVault, infraChecks, loadInfra, up } from "../lib/infra.ts";
import { clean, openInBrowser, readSecret } from "../lib/terminal.ts";
import { needInfra } from "../lib/workdir.ts";

export const command = defineCommand({
  label: "Deploy the infra",
  examples: ["achq infra up --dry-run", "achq infra up", "achq infra up --prune", "achq infra up --rotate-deployer-token"],
  context: {
    prune: { from: "flag", schema: z.boolean().default(false), description: "Delete uninstalled repos' containers" },
    dryRun: { from: "flag", schema: z.boolean().default(false), description: "Preview changes" },
    rotateDeployerToken: { from: "flag", schema: z.boolean().default(false), description: "Replace the deployer's own token, where it has one" },
  },
  pre: async () => [...(await infraChecks(needInfra(), process.env)), agentEnvCheck(process.env)],
  run: clean(async (r, { context }) => {
    const infra = await loadInfra(needInfra());
    // Where the router and deployer's code comes from: achq's own repo, on the code host.
    const source = CODE_HOST.asYou(process.env);
    const env = new Env(process.env);
    const result = await up(infra, { prune: context.prune, dryRun: context.dryRun, rotateDeployerToken: context.rotateDeployerToken }, {
      env: process.env,
      // What every container gets: each agent runtime's variables, from your shell, trimmed, as a secret pasted into a vault can end in a newline.
      containerEnv: Object.fromEntries(agentEnv().map(({ name, hint }) => [name, env.require(name, hint).trim()])),
      achqRef: () => source.lastCommit(ACHQ_SOURCE.repo, ACHQ_SOURCE.branch, ACHQ_CODE_PATHS),
      open: openInBrowser,
      prompt: (message) => readSecret(r.prompter, message),
      vault: configVault(await loadConfig(), process.env),
      log: (line) => console.log(line),
    });
    if (result) for (const line of formatSync(result, context.dryRun)) console.log(`  sync: ${line}`);
  }),
});
