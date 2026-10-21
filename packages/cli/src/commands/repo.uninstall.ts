import { defineCommand } from "@pokit/core";
import { z } from "zod";
import { planInstall } from "../lib/repo.ts";
import { clean } from "../lib/terminal.ts";

export const command = defineCommand({
  label: "Uninstall achq",
  examples: ["achq repo uninstall --dry-run", "achq repo uninstall"],
  context: {
    dryRun: { from: "flag", schema: z.boolean().default(false), description: "Preview changes" },
  },
  run: clean(async (_r, { context }) => {
    const { apply } = await planInstall("uninstall");
    if (!context.dryRun && apply) await apply();
  }),
});
