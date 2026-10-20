import { defineCommand } from "@pokit/core";
import { clean } from "../lib/errors.ts";
import type { DeployRecord, FailedDelivery, InstalledRepo } from "@achq/core";
import { cliContext } from "../lib/context.ts";
import { secretEnv } from "../lib/env.ts";
import { failedSection } from "../lib/failed.ts";
import { loadInfra } from "../lib/load/infra.ts";
import { adminRequest, routerAccess } from "../lib/router.ts";
import { formatStatus, infraStatusTable } from "../lib/status/format.ts";
import { infraFile, needRepo } from "../lib/workdir.ts";

export const command = defineCommand({
  label: "From the infra: every repo's deploy, and deliveries that failed. From a repo: its ACHQ_STATUS",
  examples: ["achq status"],
  run: clean(async () => {
    const file = infraFile();
    if (file) {
      const infra = await loadInfra(file);
      const router = await routerAccess(infra, cliContext({ env: secretEnv(), log: (line) => console.log(line) }));
      const [records, installed, failed] = await Promise.all([
        adminRequest<DeployRecord[]>(router, "GET", "/admin/status"),
        adminRequest<InstalledRepo[]>(router, "GET", "/admin/installed"),
        adminRequest<FailedDelivery[]>(router, "GET", "/admin/failed"),
      ]);
      console.log([infraStatusTable(records, installed), ...failedSection(failed)].join("\n"));
      return;
    }
    const { repo, codeHost } = needRepo();
    const status = await codeHost.status(repo);
    if (!status) {
      console.log(`${repo} has no ACHQ_STATUS: it hasn't been deployed`);
      return;
    }
    for (const line of formatStatus(status)) console.log(line);
  }),
});
