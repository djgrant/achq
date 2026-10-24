import { defineCommand } from "@pokit/core";
import { z } from "zod";
import { loadConfig } from "../lib/config.ts";
import { configVault, down, infraChecks, loadInfra } from "../lib/infra.ts";
import { clean, confirm, openInBrowser } from "../lib/terminal.ts";
import { needInfra } from "../lib/workdir.ts";

export const command = defineCommand({
  label: "Delete the infra, and every container it deployed",
  examples: ["achq infra down --dry-run", "achq infra down", "achq infra down --yes"],
  context: {
    dryRun: { from: "flag", schema: z.boolean().default(false), description: "Show what it deletes" },
    yes: { from: "flag", schema: z.boolean().default(false), description: "Don't ask first, e.g. in CI" },
  },
  pre: async () => infraChecks(needInfra(), process.env),
  run: clean(async (r, { context }) => {
    await down(await loadInfra(needInfra()), { dryRun: context.dryRun }, {
      env: process.env,
      confirm: async (message) => context.yes || (await confirm(r.prompter, message)),
      open: openInBrowser,
      vault: configVault(await loadConfig(), process.env),
      log: (line) => console.log(line),
    });
  }),
});
