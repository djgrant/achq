import { defineCommand } from "@pokit/core";
import { text } from "@achq/utils/text";
import { z } from "zod";
import { STATUS_TIMEOUT_MS } from "../constants.ts";
import { formatStatus } from "../lib/format.ts";
import { planInstall, waitForStatus } from "../lib/repo.ts";
import { clean } from "../lib/terminal.ts";

const MS_PER_MINUTE = 60_000;

export const command = defineCommand({
  label: "Install achq",
  examples: ["achq repo install --dry-run", "achq repo install"],
  context: {
    dryRun: { from: "flag", schema: z.boolean().default(false), description: "Preview changes" },
  },
  run: clean(async (_r, { context }) => {
    const since = new Date();
    const { repo, codeHost, apply } = await planInstall("install");
    if (context.dryRun || !apply) return;
    await apply();

    console.log("Waiting for the deploy's result…");
    const status = await waitForStatus((r) => codeHost.status(r), repo, since);
    if (!status) {
      const minutes = STATUS_TIMEOUT_MS / MS_PER_MINUTE;
      console.log(`No result after ${minutes} ${text.plural(minutes, "minute")}. Run \`achq infra up\` to sync installs, then \`achq repo status\`.`);
      process.exitCode = 1;
      return;
    }
    for (const line of formatStatus(status)) console.log(line);
    if (status.state === "failed") process.exitCode = 1;
  }),
});
