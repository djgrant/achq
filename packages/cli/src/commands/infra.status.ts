import { defineCommand } from "@pokit/core";
import { clean } from "../lib/errors.ts";
import type { DeployRecord, FailedDelivery, InstalledRepo } from "@achq/core";
import { cliContext } from "../lib/context.ts";
import { failedSection } from "../lib/failed.ts";
import { loadInfra } from "../lib/load/infra.ts";
import { adminRequest, routerAccess } from "../lib/router.ts";
import { infraStatusTable } from "../lib/status/format.ts";
import { needInfra } from "../lib/workdir.ts";

export const command = defineCommand({
  label: "Show all deploys and failed deliveries",
  examples: ["achq infra status"],
  run: clean(async () => {
    const infra = await loadInfra(needInfra());
    const router = await routerAccess(infra, cliContext({ env: process.env, log: (line) => console.log(line) }));
    const [records, installed, failed] = await Promise.all([
      adminRequest<DeployRecord[]>(router, "GET", "/admin/status"),
      adminRequest<InstalledRepo[]>(router, "GET", "/admin/installed"),
      adminRequest<FailedDelivery[]>(router, "GET", "/admin/failed"),
    ]);
    console.log([infraStatusTable(records, installed), ...failedSection(failed)].join("\n"));
  }),
});
