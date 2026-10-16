import { defineCommand } from "@pokit/core";
import { z } from "zod";
import { deployedRepos, railwaySsh, repoSchema } from "../lib/agent.ts";

export const command = defineCommand({
  label: "Shell into the GitHub agent container",
  examples: ["achq ssh notationlabs/yieldstar", "achq ssh notationlabs/yieldstar -- ls /data/worktrees"],
  context: {
    repo: {
      from: "arg",
      schema: repoSchema(z.string().regex(/^([\w.-]+\/)?[\w.-]+$/, "Expected owner/repo or repo")),
      description: "GitHub repo",
      resolve: deployedRepos,
    },
  },
  run: async (_r, { context }) => {
    const separator = process.argv.indexOf("--");
    process.exitCode = await railwaySsh(context.repo, separator < 0 ? [] : process.argv.slice(separator + 1));
  },
});
