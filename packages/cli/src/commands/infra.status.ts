import { defineCommand } from "@pokit/core";
import type { DeployRecord, FailedDelivery, InstalledRepo } from "@achq/core";
import { failedSection, infraStatusTable } from "../lib/format.ts";
import { adminRequest, cliContext, loadInfra, routerAccess } from "../lib/infra.ts";
import { clean } from "../lib/terminal.ts";
import { needInfra } from "../lib/workdir.ts";

export const command = defineCommand({
  label: "Show all deploys and failed deliveries",
  examples: ["achq infra status"],
  run: clean(async () => {
    const router = await routerAccess(await loadInfra(needInfra()), cliContext({ env: process.env, log: (line) => console.log(line) }));
    const [records, installed, failed] = await Promise.all([
      adminRequest<DeployRecord[]>(router, "GET", "/admin/status"),
      adminRequest<InstalledRepo[]>(router, "GET", "/admin/installed"),
      adminRequest<FailedDelivery[]>(router, "GET", "/admin/failed"),
    ]);
    console.log([infraStatusTable(records, installed), ...failedSection(failed)].join("\n"));
  }),
});
