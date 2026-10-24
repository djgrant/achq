import { defineCommand } from "@pokit/core";
import { z } from "zod";
import { loadRepoManifest, planUninstall, removeAndWait } from "../lib/repo.ts";
import { clean, openInBrowser } from "../lib/terminal.ts";
import { needRepo, repoRoot } from "../lib/workdir.ts";

export const command = defineCommand({
  label: "Uninstall achq",
  examples: ["achq repo uninstall --dry-run", "achq repo uninstall"],
  context: {
    dryRun: { from: "flag", schema: z.boolean().default(false), description: "Preview changes" },
  },
  run: clean(async (_r, { context }) => {
    const here = needRepo();
    const log = (line: string) => console.log(line);
    const { source, url } = await planUninstall(here, await loadRepoManifest(repoRoot()), { log });
    if (!context.dryRun && url) await removeAndWait(here, source, url, { log, open: openInBrowser });
  }),
});
