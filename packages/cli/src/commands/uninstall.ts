import { defineCommand } from "@pokit/core";
import { z } from "zod";
import { clean } from "../lib/errors.ts";
import { planInstallation } from "../lib/installation.ts";

export const command = defineCommand({
  label: "Remove this repo from its source's installation",
  examples: ["achq uninstall --dry-run", "achq uninstall"],
  context: {
    dryRun: { from: "flag", schema: z.boolean().default(false), description: "Show what would change, and change nothing" },
  },
  run: clean(async (_r, { context }) => {
    const { apply } = await planInstallation(false);
    if (!context.dryRun && apply) await apply();
  }),
});
