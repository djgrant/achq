import { defineCommand } from "@pokit/core";
import { clean } from "../lib/errors.ts";
import { z } from "zod";
import { reachContainer } from "../lib/remote/reach.ts";
import { needRepo, repoFlag } from "../lib/workdir.ts";

export const command = defineCommand({
  label: "Open a shell in a container",
  examples: ["achq container ssh", "achq container ssh --repo djgrant/foo --container dev -- ls /data"],
  context: {
    repo: repoFlag,
    container: { from: "flag", schema: z.string().optional(), description: "Container name" },
  },
  run: clean(async (r, { context }) => {
    const container = await reachContainer(r.prompter, needRepo(context.repo), context.container);
    const separator = process.argv.indexOf("--");
    process.exitCode = await container.shell.open(container.location, separator < 0 ? [] : process.argv.slice(separator + 1));
  }),
});
