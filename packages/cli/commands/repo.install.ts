import { defineCommand, dryRunContext } from "@pokit/core";
import { clean } from "../io/terminal.ts";
import { needRepo, repoRoot } from "../io/workdir.ts";
import { repoEvaluateManifest } from "../tasks/repo.evaluate-manifest.ts";
import { repoInstall } from "../tasks/repo.install.ts";
import { run } from "../tasks/run.ts";

export const command = defineCommand({
  label: "Install achq",
  examples: ["achq repo install --dry-run", "achq repo install"],
  context: {
    ...dryRunContext,
  },
  run: clean(async (r, { context }) => {
    const here = needRepo();
    const outcome = await run(r, repoInstall, { here, manifest: await run(r, repoEvaluateManifest, { dir: repoRoot() }), dryRun: context.dryRun });
    // No result in time, or a failed one.
    if (outcome && (!outcome.status || outcome.status.state === "failed")) process.exitCode = 1;
  }),
});
