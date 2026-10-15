import { defineCommand } from "@pokit/core";
import { z } from "zod";
import { railwaySsh } from "../lib/agent.ts";

export const command = defineCommand({
  label: "Open an issue's Claude session interactively in its agent container",
  examples: ["ak agent resume notationlabs/yieldstar 34"],
  context: {
    repo: {
      from: "arg",
      schema: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "Expected owner/repo"),
      description: "GitHub repo",
    },
    issue: {
      from: "arg",
      schema: z.coerce.number().int().positive(),
      description: "Issue number",
    },
  },
  run: async (_r, { context }) => {
    process.exitCode = await railwaySsh(context.repo, ["github-agent", "resume", String(context.issue)]);
  },
});
