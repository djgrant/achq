import { defineCommand, type Runner } from "@pokit/core";
import { routerAdmin } from "@achq/core/clients/router";
import { infraChecks } from "../checks/infra.ts";
import { clean } from "../io/terminal.ts";
import { needInfra } from "../io/workdir.ts";
import { failedSection } from "../renderers/deliveries.ts";
import { infraStatusTable } from "../renderers/status.ts";
import { infraFindRouter } from "../tasks/infra.find-router.ts";
import { infraLoad } from "../tasks/infra.load.ts";
import { run } from "../tasks/run.ts";

export const command = defineCommand({
  label: "Show all deploys and failed deliveries",
  examples: ["achq infra status"],
  pre: () => infraChecks(needInfra(), process.env),
  run: clean(async (r: Runner) => {
    const admin = routerAdmin(await run(r, infraFindRouter, { infra: await run(r, infraLoad, { file: needInfra() }) }));
    const [records, installed, failed] = await Promise.all([admin.status(), admin.installed(), admin.failed()]);
    console.log([infraStatusTable(records, installed), ...failedSection(failed)].join("\n"));
  }),
});
