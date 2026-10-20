import { defineCommand } from "@pokit/core";
import type { ReplayResult } from "@achq/core";
import { INFRA_FILE } from "../constants.ts";
import { cliContext } from "../lib/context.ts";
import { secretEnv } from "../lib/env.ts";
import { clean } from "../lib/errors.ts";
import { formatReplay } from "../lib/failed.ts";
import { loadInfra } from "../lib/load/infra.ts";
import { adminRequest, routerAccess } from "../lib/router.ts";
import { infraFile } from "../lib/workdir.ts";

export const command = defineCommand({
  label: "Send the deliveries the router gave up on again, to where their containers are now",
  examples: ["achq replay"],
  run: clean(async () => {
    const file = infraFile();
    if (!file) throw new Error(`Run this in the ACHQ infra repo, which has ${INFRA_FILE} at its root`);
    const router = await routerAccess(await loadInfra(file), cliContext({ env: secretEnv(), log: (line) => console.log(line) }));
    for (const line of formatReplay(await adminRequest<ReplayResult>(router, "POST", "/admin/failed/replay"))) console.log(line);
  }),
});
