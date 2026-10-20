import { defineCommand } from "@pokit/core";
import { z } from "zod";
import { clean } from "../lib/errors.ts";
import { planInstall } from "../lib/install.ts";

export const command = defineCommand({
  label: "Take this repo off achq on its code host",
  examples: ["achq uninstall --dry-run", "achq uninstall"],
  context: {
    dryRun: { from: "flag", schema: z.boolean().default(false), description: "Show what would change, and change nothing" },
  },
  run: clean(async (_r, { context }) => {
    const { apply } = await planInstall("uninstall");
    if (!context.dryRun && apply) await apply();
  }),
});
