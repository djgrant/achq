import { defineCommand } from "@pokit/core";
import { clean } from "../lib/errors.ts";
import { z } from "zod";
import { RailwayClient } from "@achq/railway/api";
import { ACHQ_SOURCE } from "@achq/railway/runtime";
import { ENV } from "@achq/core";
import { CLI_ENV, INFRA_FILE } from "../constants.ts";
import { lastCommit } from "../lib/achq-ref.ts";
import { openInBrowser } from "../lib/browser.ts";
import { need } from "../lib/env.ts";
import { userGitHub } from "../lib/gh.ts";
import { loadInfra } from "../lib/load/infra.ts";
import { manifestFlow } from "../lib/manifest.ts";
import { infraExpanders } from "../lib/up/expanders.ts";
import { formatSync } from "../lib/up/format.ts";
import { up } from "../lib/up/up.ts";
import { infraFile } from "../lib/workdir.ts";

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
    const railwayToken = need(CLI_ENV.railwayToken, "Create a token at https://railway.com/account/tokens.");
    const log = (line: string) => console.log(line);
    const expanders = infraExpanders({
      railway: new RailwayClient(railwayToken),
      workspaceId: process.env[CLI_ENV.railwayWorkspace],
      ref: await lastCommit(userGitHub(), ACHQ_SOURCE),
      tokens: { railway: railwayToken, claude: need(ENV.claudeToken, "Run `claude setup-token`.") },
      createApp: (request) =>
        manifestFlow(request, {
          open: async (url) => {
            console.log(`  opening ${url} to create ${request.name} on GitHub…`);
            await openInBrowser(url);
          },
        }),
      log,
    });
    const result = await up(infra, { prune: context.prune, dryRun: context.dryRun }, { expanders, log });
    if (result) for (const line of formatSync(result, context.dryRun)) console.log(`  sync: ${line}`);
  }),
});
