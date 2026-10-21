import { defineCommand } from "@pokit/core";
import { clean } from "../lib/terminal.ts";

export const command = defineCommand({
  label: "Tear down the infra (not implemented)",
  examples: ["achq infra down"],
  run: clean(async () => {
    throw new Error("Not implemented yet");
  }),
});
