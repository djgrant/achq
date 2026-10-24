import { defineCommand } from "@pokit/core";
import { routerAdmin } from "@achq/core/client";
import { context } from "@achq/core/context";
import { formatReplay } from "../lib/format.ts";
import { infraChecks, loadInfra, routerAccess } from "../lib/infra.ts";
import { clean } from "../lib/terminal.ts";
import { needInfra } from "../lib/workdir.ts";

export const command = defineCommand({
  label: "Retry failed deliveries",
  examples: ["achq infra replay"],
  pre: () => infraChecks(needInfra(), process.env),
  run: clean(async () => {
    const admin = routerAdmin(await routerAccess(await loadInfra(needInfra()), context({ env: process.env, log: (line) => console.log(line) })));
    for (const line of formatReplay(await admin.replay())) console.log(line);
  }),
});
