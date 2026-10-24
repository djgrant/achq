import { defineCommand } from "@pokit/core";
import { routerAdmin } from "@achq/core/client";
import { context } from "@achq/core/context";
import { failedSection, infraStatusTable } from "../lib/format.ts";
import { infraChecks, loadInfra, routerAccess } from "../lib/infra.ts";
import { clean } from "../lib/terminal.ts";
import { needInfra } from "../lib/workdir.ts";

export const command = defineCommand({
  label: "Show all deploys and failed deliveries",
  examples: ["achq infra status"],
  pre: () => infraChecks(needInfra(), process.env),
  run: clean(async () => {
    const admin = routerAdmin(await routerAccess(await loadInfra(needInfra()), context({ env: process.env, log: (line) => console.log(line) })));
    const [records, installed, failed] = await Promise.all([admin.status(), admin.installed(), admin.failed()]);
    console.log([infraStatusTable(records, installed), ...failedSection(failed)].join("\n"));
  }),
});
