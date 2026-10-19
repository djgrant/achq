import { defineCommand } from "@pokit/core";
import { clean } from "../lib/errors.ts";
import { z } from "zod";
import { channelNamed } from "achq/registry";
import { needRepo, repoRoot } from "../lib/workdir.ts";
import { openInBrowser } from "../lib/browser.ts";
import { channelsOf, loadRepoPlan } from "../lib/load/repo-config.ts";
import { formatStatus } from "../lib/status/format.ts";
import { waitForStatus } from "../lib/status/read.ts";

export const command = defineCommand({
  label: "Install the source this repo's .achq/config.ts names, and wait for the deploy",
  examples: ["achq install --dry-run", "achq install"],
  context: {
    dryRun: { from: "flag", schema: z.boolean().default(false), description: "Check the config against its source, and install nothing" },
  },
  run: clean(async (_r, { context }) => {
    const { repo, repoHost } = needRepo();
    const plan = await loadRepoPlan(repoRoot());
    const since = new Date();
    for (const id of channelsOf(plan)) {
      await channelNamed(id).create(process.env).install(repo, plan, { dryRun: context.dryRun, open: openInBrowser, log: (line) => console.log(line) });
    }
    if (context.dryRun) return;

    console.log("Waiting for the deploy's result…");
    const status = await waitForStatus((r) => repoHost.status(r), repo, since);
    if (!status) {
      console.log("No result after 3 minutes. Run `achq up` from the infra to sync installs, then `achq status`.");
      process.exitCode = 1;
      return;
    }
    for (const line of formatStatus(status)) console.log(line);
    if (status.state === "failed") process.exitCode = 1;
  }),
});
