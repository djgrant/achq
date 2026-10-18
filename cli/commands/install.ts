import { defineCommand } from "@pokit/core";
import { clean } from "../lib/errors.ts";
import { z } from "zod";
import { needRepo, repoRoot } from "../lib/env.ts";
import { userGitHub } from "../lib/gh.ts";
import { checkApp, configApp, formatStatus, installRepo, waitForStatus } from "../lib/install.ts";
import { loadRepoPlan } from "../lib/load.ts";
import { openInBrowser } from "../lib/manifest.ts";

export const command = defineCommand({
  label: "Install the App this repo's .achq/config.ts names, and wait for the deploy",
  examples: ["achq install --dry-run", "achq install"],
  context: {
    dryRun: { from: "flag", schema: z.boolean().default(false), description: "Check the config against the App, and install nothing" },
  },
  run: clean(async (_r, { context }) => {
    const repo = needRepo();
    const plan = await loadRepoPlan(repoRoot());
    const slug = configApp(plan);
    const gh = userGitHub();
    const check = await checkApp(gh, slug, plan);
    if (check.private) console.log(`${slug} is private, so GitHub won't show its settings; skipping the App check`);
    else if (check.missing.length) throw new Error(`${slug} doesn't have what ${repo}'s config needs: ${check.missing.join(", ")}`);
    else console.log(`${slug} has the events and permissions the config needs`);
    if (context.dryRun) return;

    const since = new Date();
    const result = await installRepo(gh, slug, repo);
    if (result.kind === "open") {
      console.log(`${slug} isn't installed on ${repo.split("/")[0]} yet. Install it on ${repo} at ${result.url}`);
      await openInBrowser(result.url);
    } else if (result.kind === "already") {
      console.log(`${slug} is already installed on ${repo}${result.all ? " (all repositories)" : ""}`);
    } else {
      console.log(`Installed ${slug} on ${repo}`);
    }
    console.log("Waiting for the deploy's result…");
    const status = await waitForStatus(gh, repo, since);
    if (!status) {
      console.log("No result after 3 minutes. Run `achq up` from the infra to sync installs, then `achq status`.");
      process.exitCode = 1;
      return;
    }
    for (const line of formatStatus(status)) console.log(line);
    if (status.state === "failed") process.exitCode = 1;
  }),
});
