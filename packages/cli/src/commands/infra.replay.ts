import { defineCommand } from "@pokit/core";
import type { ReplayResult } from "@achq/core";
import { cliContext } from "../lib/context.ts";
import { secretEnv } from "../lib/env.ts";
import { clean } from "../lib/errors.ts";
import { formatReplay } from "../lib/failed.ts";
import { loadInfra } from "../lib/load/infra.ts";
import { adminRequest, routerAccess } from "../lib/router.ts";
import { needInfra } from "../lib/workdir.ts";

export const command = defineCommand({
  label: "Retry failed deliveries",
  examples: ["achq infra replay"],
  run: clean(async () => {
    const file = needInfra();
    const router = await routerAccess(await loadInfra(file), cliContext({ env: secretEnv(), log: (line) => console.log(line) }));
    for (const line of formatReplay(await adminRequest<ReplayResult>(router, "POST", "/admin/failed/replay"))) console.log(line);
  }),
});
