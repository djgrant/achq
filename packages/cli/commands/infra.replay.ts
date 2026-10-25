import { defineCommand, type Runner } from "@pokit/core";
import { routerAdmin } from "@achq/core/clients/router";
import { infraChecks } from "../checks/infra.ts";
import { clean } from "../io/terminal.ts";
import { needInfra } from "../io/workdir.ts";
import { formatReplay } from "../renderers/deliveries.ts";
import { infraFindRouter } from "../tasks/infra.find-router.ts";
import { infraLoad } from "../tasks/infra.load.ts";
import { run } from "../tasks/run.ts";

export const command = defineCommand({
  label: "Retry failed deliveries",
  examples: ["achq infra replay"],
  pre: () => infraChecks(needInfra(), process.env),
  run: clean(async (r: Runner) => {
    const admin = routerAdmin(await run(r, infraFindRouter, { infra: await run(r, infraLoad, { file: needInfra() }) }));
    for (const line of formatReplay(await admin.replay())) console.log(line);
  }),
});
