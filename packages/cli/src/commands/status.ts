import { defineCommand } from "@pokit/core";
import { clean } from "../lib/errors.ts";
import type { DeployRecord, Installation } from "@achq/core";
import { secretEnv } from "../lib/env.ts";
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
      const router = await routerAccess(infra.platform.infra(infra, secretEnv()), infra.router.name);
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
