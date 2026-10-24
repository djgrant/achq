import { defineCommand } from "@pokit/core";
import { failedSection, infraStatusTable } from "../lib/format.ts";
import { adminClient, infraChecks } from "../lib/infra.ts";
import { clean } from "../lib/terminal.ts";
import { needInfra } from "../lib/workdir.ts";

export const command = defineCommand({
  label: "Show all deploys and failed deliveries",
  examples: ["achq infra status"],
  pre: () => infraChecks(needInfra(), process.env),
  run: clean(async () => {
    const admin = await adminClient(needInfra(), { env: process.env, log: (line) => console.log(line) });
    const [records, installed, failed] = await Promise.all([admin.status(), admin.installed(), admin.failed()]);
    console.log([infraStatusTable(records, installed), ...failedSection(failed)].join("\n"));
  }),
});
