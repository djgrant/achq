import { defineCommand } from "@pokit/core";
import { z } from "zod";
import { deployedRepos, railwaySsh } from "../lib/agent.ts";

export const command = defineCommand({
  label: "Open a shell in a repo's GitHub agent container",
  examples: ["ak agent ssh notationlabs/yieldstar", "ak agent ssh notationlabs/yieldstar -- ls /data/worktrees"],
  context: {
    repo: {
      from: "arg",
      schema: z.string().regex(/^([\w.-]+\/)?[\w.-]+$/, "Expected owner/repo or repo"),
      description: "GitHub repo",
      resolve: deployedRepos,
    },
  },
  run: async (_r, { context }) => {
    const separator = process.argv.indexOf("--");
    process.exitCode = await railwaySsh(context.repo, separator < 0 ? [] : process.argv.slice(separator + 1));
  },
});
