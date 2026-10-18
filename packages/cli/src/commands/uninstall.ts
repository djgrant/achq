import { defineCommand } from "@pokit/core";
import { clean } from "../lib/errors.ts";
import { needRepo, repoRoot } from "../lib/env.ts";
import { userGitHub } from "../lib/gh.ts";
import { configApp, uninstallRepo } from "../lib/install.ts";
import { loadRepoPlan } from "../lib/load.ts";

export const command = defineCommand({
  label: "Remove this repo from its App's installation",
  examples: ["achq uninstall"],
  run: clean(async () => {
    const repo = needRepo();
    const slug = configApp(await loadRepoPlan(repoRoot()));
    await uninstallRepo(userGitHub(), slug, repo);
    console.log(`Removed ${repo} from ${slug}. Its containers sleep and are kept until \`achq up --prune\`.`);
  }),
});
