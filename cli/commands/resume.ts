import { defineCommand } from "@pokit/core";
import { z } from "zod";
import { deployedRepos, railwaySsh, recentIssues, repoSchema } from "../lib/agent.ts";

export const command = defineCommand({
  label: "Resume the Github agent's last Claude session",
  examples: ["achq resume 34", "achq resume 34 notationlabs/yieldstar"],
  context: {
    issue: {
      from: "arg",
      schema: z.coerce.number().int().positive(),
      description: "Issue",
      resolve: recentIssues,
      dependsOn: ["repo"],
    },
    repo: {
      from: "arg",
      schema: repoSchema(z.string().regex(/^([\w.-]+\/)?[\w.-]+$/, "Expected owner/repo or repo")),
      description: "GitHub repo",
      resolve: deployedRepos,
    },
  },
  run: async (_r, { context }) => {
    // Railway's SSH sets TERM=xterm and nothing else, so Claude can't tell which
    // keys your terminal can send (Shift+Enter and the like). Pass your terminal's on.
    const term = ["TERM", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"].flatMap((name) =>
      process.env[name] ? [`${name}=${process.env[name]}`] : [],
    );
    process.exitCode = await railwaySsh(context.repo, ["env", ...term, "achq-agent", "resume", String(context.issue)]);
  },
});
