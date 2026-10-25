import { defineCommand, dryRunContext } from "@pokit/core";
import { z } from "zod";
import { infraChecks } from "../checks/infra.ts";
import { configVault, loadConfig } from "../envs/config.ts";
import { clean, confirm } from "../io/terminal.ts";
import { needInfra } from "../io/workdir.ts";
import { infraLoad } from "../tasks/infra.load.ts";
import { infraTearDown } from "../tasks/infra.tear-down.ts";
import { run } from "../tasks/run.ts";

export const command = defineCommand({
  label: "Delete the infra, and every container it deployed",
  examples: ["achq infra down --dry-run", "achq infra down", "achq infra down --yes"],
  context: {
    ...dryRunContext,
    yes: { from: "flag", schema: z.boolean().default(false), description: "Don't ask first, e.g. in CI" },
  },
  pre: async () => infraChecks(needInfra(), process.env),
  run: clean(async (r, { context }) => {
    await run(r, infraTearDown, {
      infra: await run(r, infraLoad, { file: needInfra() }),
      dryRun: context.dryRun,
      confirm: async (message) => context.yes || (await confirm(r.prompter, message)),
      vault: configVault(await loadConfig(), process.env),
    });
  }),
});
