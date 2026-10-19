import { defineCommand } from "@pokit/core";
import { channelNamed } from "achq/registry";
import { clean } from "../lib/errors.ts";
import { channelsOf, loadRepoPlan } from "../lib/load/repo-config.ts";
import { needRepo, repoRoot } from "../lib/workdir.ts";

export const command = defineCommand({
  label: "Remove this repo from its source's installation",
  examples: ["achq uninstall"],
  run: clean(async () => {
    const { repo } = needRepo();
    const plan = await loadRepoPlan(repoRoot());
    for (const id of channelsOf(plan)) console.log(await channelNamed(id).create(process.env).uninstall(repo, plan));
  }),
});
