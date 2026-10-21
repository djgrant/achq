import { defineCommand } from "@pokit/core";
import { clean } from "../lib/errors.ts";
import { z } from "zod";
import { text } from "@achq/utils/text";
import { STATUS_TIMEOUT_MS } from "../constants.ts";
import { planInstall } from "../lib/install.ts";
import { formatStatus } from "../lib/status/format.ts";
import { waitForStatus } from "../lib/status/read.ts";

const MS_PER_MINUTE = 60_000;

/** e.g. `3 minutes`. */
const inMinutes = (ms: number) => {
  const minutes = ms / MS_PER_MINUTE;
  return `${minutes} ${text.plural(minutes, "minute")}`;
};

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
      console.log(`No result after ${inMinutes(STATUS_TIMEOUT_MS)}. Run \`achq infra up\` to sync installs, then \`achq repo status\`.`);
      process.exitCode = 1;
      return;
    }
    for (const line of formatStatus(status)) console.log(line);
    if (status.state === "failed") process.exitCode = 1;
  }),
});
