import { defineCommand } from "@pokit/core";
import { clean } from "../io/terminal.ts";
import { needRepo, notSetUp, repoFlag } from "../io/workdir.ts";
import { formatStatus } from "../renderers/status.ts";
import { repoReadStatus } from "../tasks/repo.read-status.ts";
import { run } from "../tasks/run.ts";

export const command = defineCommand({
  label: "Show deploy status",
  examples: ["achq repo status", "achq repo status --repo djgrant/foo"],
  context: {
    repo: repoFlag,
  },
  run: clean(async (r, { context }) => {
    const here = needRepo(context.repo);
    const status = await run(r, repoReadStatus, { here });
    if (!status) {
      console.log(notSetUp(here.repo));
      return;
    }
    for (const line of formatStatus(status)) console.log(line);
  }),
});
