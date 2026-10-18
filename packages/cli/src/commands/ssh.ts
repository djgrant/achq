import { defineCommand } from "@pokit/core";
import { clean } from "../lib/errors.ts";
import { z } from "zod";
import { railwaySsh } from "../lib/remote/railway-ssh.ts";
import { reachContainer } from "../lib/remote/reach.ts";
import { needRepo } from "../lib/workdir.ts";

export const command = defineCommand({
  label: "Shell into one of this repo's containers",
  examples: ["achq ssh", "achq ssh --container dev -- ls /data"],
  context: {
    container: { from: "flag", schema: z.string().optional(), description: "Which container, when the repo has several" },
  },
  run: clean(async (r, { context }) => {
    const container = await reachContainer(r.prompter, needRepo(), context.container);
    const separator = process.argv.indexOf("--");
    process.exitCode = await railwaySsh(container, separator < 0 ? [] : process.argv.slice(separator + 1));
  }),
});
