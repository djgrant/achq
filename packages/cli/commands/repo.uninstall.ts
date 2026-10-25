import { defineCommand, dryRunContext } from "@pokit/core";
import { clean } from "../io/terminal.ts";
import { needRepo, repoRoot } from "../io/workdir.ts";
import { repoEvaluateManifest } from "../tasks/repo.evaluate-manifest.ts";
import { repoUninstall } from "../tasks/repo.uninstall.ts";
import { run } from "../tasks/run.ts";

export const command = defineCommand({
  label: "Uninstall achq",
  examples: ["achq repo uninstall --dry-run", "achq repo uninstall"],
  context: {
    ...dryRunContext,
  },
  run: clean(async (r, { context }) => {
    await run(r, repoUninstall, { here: needRepo(), manifest: await run(r, repoEvaluateManifest, { dir: repoRoot() }), dryRun: context.dryRun });
  }),
});
