import { defineCommand } from "@pokit/core";
import { clean } from "../lib/errors.ts";
import type { DeployRecord, Installation } from "@achq/core";
import * as railway from "@achq/railway";
import { RailwayClient } from "@achq/railway/api";
import { CLI_ENV } from "../constants.ts";
import { need } from "../lib/env.ts";
import { userGitHub } from "../lib/gh.ts";
import { loadInfra } from "../lib/load/infra.ts";
import { adminRequest, routerAccess } from "../lib/router.ts";
import { formatStatus, infraStatusTable } from "../lib/status/format.ts";
import { readStatus } from "../lib/status/read.ts";
import { infraFile, needRepo } from "../lib/workdir.ts";

export const command = defineCommand({
  label: "From the infra: every repo's deploy. From a repo: its ACHQ_STATUS",
  examples: ["achq status"],
  run: clean(async () => {
    const file = infraFile();
    if (file) {
      const infra = await loadInfra(file);
      if (!(infra.router instanceof railway.Router)) throw new Error("achq status can only reach a Railway router");
      const router = await routerAccess(new RailwayClient(need(CLI_ENV.railwayToken)), infra.router.inputs.project, infra.router.name, process.env[CLI_ENV.railwayWorkspace]);
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
