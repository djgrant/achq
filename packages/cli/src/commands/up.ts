import { defineCommand } from "@pokit/core";
import { clean } from "../lib/errors.ts";
import { z } from "zod";
import { ACHQ_SOURCE, ENV } from "@achq/core";
import { INFRA_FILE } from "../constants.ts";
import { lastCommit } from "../lib/achq-ref.ts";
import { openInBrowser } from "../lib/browser.ts";
import { need, secretEnv } from "../lib/env.ts";
import { userGitHub } from "../lib/gh.ts";
import { loadInfra } from "../lib/load/infra.ts";
import { manifestFlow } from "../lib/manifest.ts";
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
    const result = await up(infra, { prune: context.prune, dryRun: context.dryRun }, {
      platform: infra.platform.infra(infra, secretEnv()),
      claudeToken: need(ENV.claudeToken, "Run `claude setup-token`."),
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
