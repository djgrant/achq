import { defineCommand, dryRunContext } from "@pokit/core";
import { Env } from "@achq/utils/env";
import { z } from "zod";
import { infraChecks, runtimesEnv } from "../checks/infra.ts";
import { loadConfig } from "../envs/config.ts";
import { clean } from "../io/terminal.ts";
import { needInfra } from "../io/workdir.ts";
import { formatSync } from "../renderers/sync.ts";
import { infraApply } from "../tasks/infra.apply.ts";
import { infraLoad } from "../tasks/infra.load.ts";
import { run } from "../tasks/run.ts";

export const command = defineCommand({
  label: "Deploy the infra",
  examples: ["achq infra up --dry-run", "achq infra up", "achq infra up --prune", "achq infra up --rotate-deployer-token"],
  context: {
    prune: { from: "flag", schema: z.boolean().default(false), description: "Delete uninstalled repos' containers" },
    ...dryRunContext,
    rotateDeployerToken: { from: "flag", schema: z.boolean().default(false), description: "Replace the deployer's own token, where it has one" },
  },
  pre: async () => infraChecks(needInfra(), process.env),
  run: clean(async (r, { context }) => {
    const env = new Env(process.env);
    const infra = await run(r, infraLoad, { file: needInfra() });
    const result = await run(r, infraApply, {
      infra,
      prune: context.prune,
      dryRun: context.dryRun,
      rotateDeployerToken: context.rotateDeployerToken,
      // What every container gets: each agent runtime's variables, from your shell, trimmed, as a secret pasted into a vault can end in a newline.
      containerEnv: Object.fromEntries(runtimesEnv(infra.runtimes).map(({ name, hint }) => [name, env.require(name, hint).trim()])),
      vault: (await loadConfig())?.vault,
    });
    if (result) for (const line of formatSync(result, context.dryRun)) console.log(`  sync: ${line}`);
  }),
});
