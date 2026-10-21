import { defineCommand } from "@pokit/core";
import { formatStatus } from "../lib/format.ts";
import { clean } from "../lib/terminal.ts";
import { needRepo, notSetUp, repoFlag } from "../lib/workdir.ts";

export const command = defineCommand({
  label: "Show deploy status",
  examples: ["achq repo status", "achq repo status --repo djgrant/foo"],
  context: {
    repo: repoFlag,
  },
  run: clean(async (_r, { context }) => {
    const { repo, codeHost } = needRepo(context.repo);
    const status = await codeHost.status(repo);
    if (!status) {
      console.log(notSetUp(repo));
      return;
    }
    for (const line of formatStatus(status)) console.log(line);
  }),
});
