import { defineCommand } from "@pokit/core";
import { clean } from "../lib/errors.ts";
import { z } from "zod";
import { RailwayClient } from "@achq/railway";
import { ACHQ_SOURCE } from "@achq/railway";
import { infraFile, INFRA_FILE, need } from "../lib/env.ts";
import { lastCommit, userGitHub } from "../lib/gh.ts";
import { loadInfra } from "../lib/load.ts";
import { manifestFlow, openInBrowser } from "../lib/manifest.ts";
import { formatSync, up } from "../lib/up.ts";

export const command = defineCommand({
  label: "Bring the ACHQ infra in line with achq.infra.ts",
  examples: ["achq up --dry-run", "achq up", "achq up --prune"],
  context: {
    prune: { from: "flag", schema: z.boolean().default(false), description: "Delete the containers and volumes of repos no longer installed" },
    dryRun: { from: "flag", schema: z.boolean().default(false), description: "Show what would change, and change nothing" },
  },
  run: clean(async (_r, { context }) => {
    const file = infraFile();
    if (!file) throw new Error(`Run this in the ACHQ infra repo, which has ${INFRA_FILE} at its root`);
    const infra = await loadInfra(file);
    const railwayToken = need("RAILWAY_API_TOKEN", "Create a token at https://railway.com/account/tokens.");
    const result = await up(infra, { prune: context.prune, dryRun: context.dryRun }, {
      railway: new RailwayClient(railwayToken),
      railwayToken,
      claudeToken: need("CLAUDE_CODE_OAUTH_TOKEN", "Run `claude setup-token`."),
      workspaceId: process.env.RAILWAY_WORKSPACE_ID,
      achqRef: () => lastCommit(userGitHub(), ACHQ_SOURCE),
      createApp: (request) =>
        manifestFlow(request, {
          open: async (url) => {
            console.log(`  opening ${url} to create ${request.name} on GitHub…`);
            await openInBrowser(url);
          },
        }),
      log: (line) => console.log(line),
    });
    if (result) for (const line of formatSync(result, context.dryRun)) console.log(`  sync: ${line}`);
  }),
});
