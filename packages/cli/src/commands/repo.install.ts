import { defineCommand } from "@pokit/core";
import type { Status } from "@achq/core";
import { subprocess } from "@achq/utils/subprocess";
import { text } from "@achq/utils/text";
import { z } from "zod";
import { STATUS_TIMEOUT_MS } from "../constants.ts";
import { formatStatus } from "../lib/format.ts";
import { fixInBrowser, planInstall, redeploy, waitForStatus } from "../lib/repo.ts";
import { clean, interactive, waitForEnter } from "../lib/terminal.ts";

const MS_PER_MINUTE = 60_000;

/** A deploy that failed with something only you can fix, in your browser. */
const needsYou = (status: Status | undefined) => status?.state === "failed" && !!status.action;

export const command = defineCommand({
  label: "Install achq",
  examples: ["achq repo install --dry-run", "achq repo install"],
  context: {
    dryRun: { from: "flag", schema: z.boolean().default(false), description: "Preview changes" },
  },
  run: clean(async (_r, { context }) => {
    const since = new Date();
    const { host, repo, codeHost, apply } = await planInstall("install");
    if (context.dryRun) return;
    let status: Status | undefined;
    if (apply) {
      await apply();
      console.log("Waiting for the deploy's result…");
      status = await waitForStatus((r) => codeHost.status(r), repo, since);
    } else {
      // Installed already: only a deploy that failed with something for you to fix is left to do.
      status = await codeHost.status(repo);
      if (!needsYou(status)) return;
    }
    const shown = needsYou(status) ? status : undefined;
    if (shown) for (const line of formatStatus(shown)) console.log(line);
    status = await fixInBrowser(repo, status, {
      status: (r) => codeHost.status(r),
      interactive: interactive(),
      open: async (url, what) => {
        console.log(`Opening ${url} to ${what}…`);
        subprocess.openUrl(url);
      },
      waitForYou: () => waitForEnter("Press Enter once you have."),
      redeploy: (router, r) => redeploy(router, { host, repo: r }, codeHost.token()),
      log: (line) => console.log(line),
    });
    if (!status) {
      const minutes = STATUS_TIMEOUT_MS / MS_PER_MINUTE;
      console.log(`No result after ${minutes} ${text.plural(minutes, "minute")}. Run \`achq infra up\` to sync installs, then \`achq repo status\`.`);
      process.exitCode = 1;
      return;
    }
    if (status !== shown) for (const line of formatStatus(status)) console.log(line);
    if (status.state === "failed") process.exitCode = 1;
  }),
});
