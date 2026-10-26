import { defineCommand } from "@pokit/core";
import { z } from "zod";
import { clean } from "../io/terminal.ts";
import { needRepo, repoFlag } from "../io/workdir.ts";
import { containerReach } from "../tasks/container.reach.ts";
import { run } from "../tasks/run.ts";

export const command = defineCommand({
  label: "Open a shell in a container",
  examples: ["achq container ssh", "achq container ssh --repo djgrant/foo --container dev -- ls /data"],
  context: {
    repo: repoFlag,
    container: { from: "flag", schema: z.string().optional(), description: "Container name" },
  },
  run: clean(async (r, { context }) => {
    const container = await run(r, containerReach, { here: needRepo(context.repo), wanted: context.container });
    const separator = process.argv.indexOf("--");
    process.exitCode = await container.open(separator < 0 ? [] : process.argv.slice(separator + 1));
  }),
});
