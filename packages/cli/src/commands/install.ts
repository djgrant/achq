import { defineCommand } from "@pokit/core";
import { clean } from "../lib/errors.ts";
import { z } from "zod";
import { planInstallation } from "../lib/installation.ts";
import { formatStatus } from "../lib/status/format.ts";
import { waitForStatus } from "../lib/status/read.ts";

export const command = defineCommand({
  label: "Install the source this repo's .achq/config.ts names, and wait for the deploy",
  examples: ["achq install --dry-run", "achq install"],
  context: {
    dryRun: { from: "flag", schema: z.boolean().default(false), description: "Check the config against its source and show what installing would change, and change nothing" },
  },
  run: clean(async (_r, { context }) => {
    const since = new Date();
    const { repo, repoHost, apply } = await planInstallation(true);
    if (context.dryRun || !apply) return;
    await apply();

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
