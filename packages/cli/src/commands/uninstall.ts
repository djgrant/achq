import { defineCommand } from "@pokit/core";
import { clean } from "../lib/errors.ts";
import { loadRepoPlan } from "../lib/load/repo-config.ts";
import { needRepo, repoRoot } from "../lib/workdir.ts";

export const command = defineCommand({
  label: "Remove this repo from its source's installation",
  examples: ["achq uninstall"],
  run: clean(async () => {
    const { repo, cli } = needRepo();
    console.log(await cli.uninstall(repo, await loadRepoPlan(repoRoot())));
  }),
});
