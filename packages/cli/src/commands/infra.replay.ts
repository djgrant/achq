import { defineCommand } from "@pokit/core";
import type { ReplayResult } from "@achq/core";
import { formatReplay } from "../lib/format.ts";
import { adminRequest, cliContext, loadInfra, routerAccess } from "../lib/infra.ts";
import { clean } from "../lib/terminal.ts";
import { needInfra } from "../lib/workdir.ts";

export const command = defineCommand({
  label: "Retry failed deliveries",
  examples: ["achq infra replay"],
  run: clean(async () => {
    const router = await routerAccess(await loadInfra(needInfra()), cliContext({ env: process.env, log: (line) => console.log(line) }));
    for (const line of formatReplay(await adminRequest<ReplayResult>(router, "POST", "/admin/failed/replay"))) console.log(line);
  }),
});
