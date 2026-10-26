import { defineCommand, dryRunContext } from "@pokit/core";
import { ACHQ_SOURCE } from "@achq/core";
import { Env } from "@achq/utils/env";
import { agentContainerEnv, CODE_HOST } from "@achq/registry";
import { z } from "zod";
import { agentContainerEnvCheck, infraChecks } from "../checks/infra.ts";
import { configVault, loadConfig } from "../envs/config.ts";
import { clean } from "../io/terminal.ts";
import { needInfra } from "../io/workdir.ts";
import { formatSync } from "../renderers/sync.ts";
import { infraApply } from "../tasks/infra.apply.ts";
import { infraLoad } from "../tasks/infra.load.ts";
import { run } from "../tasks/run.ts";

/** The paths in achq whose latest commit is the version the router and deployer run. */
const ACHQ_CODE_PATHS = ["packages", "package.json", "bun.lock"];

export const command = defineCommand({
  label: "Deploy the infra",
  examples: ["achq infra up --dry-run", "achq infra up", "achq infra up --prune", "achq infra up --rotate-deployer-token"],
  context: {
    prune: { from: "flag", schema: z.boolean().default(false), description: "Delete uninstalled repos' containers" },
    ...dryRunContext,
    rotateDeployerToken: { from: "flag", schema: z.boolean().default(false), description: "Replace the deployer's own token, where it has one" },
  },
  pre: async () => [...(await infraChecks(needInfra(), process.env)), agentContainerEnvCheck(process.env)],
  run: clean(async (r, { context }) => {
    // Where the router and deployer's code comes from: achq's own repo, on the code host.
    const source = CODE_HOST.asYou(process.env);
    const env = new Env(process.env);
    const result = await run(r, infraApply, {
      infra: await run(r, infraLoad, { file: needInfra() }),
      prune: context.prune,
      dryRun: context.dryRun,
      rotateDeployerToken: context.rotateDeployerToken,
      // What every container gets: each agent runtime's variables, from your shell, trimmed, as a secret pasted into a vault can end in a newline.
      containerEnv: Object.fromEntries(agentContainerEnv().map(({ name, hint }) => [name, env.require(name, hint).trim()])),
      achqRef: () => source.lastCommit(ACHQ_SOURCE.repo, ACHQ_SOURCE.branch, ACHQ_CODE_PATHS),
      vault: configVault(await loadConfig(), process.env),
    });
    if (result) for (const line of formatSync(result, context.dryRun)) console.log(`  sync: ${line}`);
  }),
});
