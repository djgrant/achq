import { defineCommand } from "@pokit/core";
import { clean } from "../lib/errors.ts";
import type { DeployRecord, Installation } from "../../src/core/protocol.ts";
import { RailwayClient } from "../../src/railway/client.ts";
import { infraFile, need, needRepo } from "../lib/env.ts";
import { readStatus, userGitHub } from "../lib/gh.ts";
import { formatStatus } from "../lib/install.ts";
import { loadInfra } from "../lib/load.ts";
import { adminRequest, routerAccess } from "../lib/router.ts";
import { infraStatusTable } from "../lib/status.ts";

export const command = defineCommand({
  label: "From the infra: every repo's deploy. From a repo: its ACHQ_STATUS",
  examples: ["achq status"],
  run: clean(async () => {
    const file = infraFile();
    if (file) {
      const infra = await loadInfra(file);
      const router = await routerAccess(new RailwayClient(need("RAILWAY_API_TOKEN")), infra.project, infra.router.name, process.env.RAILWAY_WORKSPACE_ID);
      const [records, installations] = await Promise.all([
        adminRequest<DeployRecord[]>(router, "GET", "/admin/status"),
        adminRequest<Installation[]>(router, "GET", "/admin/installations"),
      ]);
      console.log(infraStatusTable(records, installations));
      return;
    }
    const repo = needRepo();
    const status = await readStatus(userGitHub(), repo);
    if (!status) {
      console.log(`${repo} has no ACHQ_STATUS: it hasn't been deployed`);
      return;
    }
    for (const line of formatStatus(status)) console.log(line);
  }),
});
