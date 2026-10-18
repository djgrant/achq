import { defineConfig } from "@pokit/core";

// The global `pok` binary loads this when run inside the repo. `bin/achq` runs cli/main.ts instead, which needs no global `pok`.
export default defineConfig({
  appName: "achq",
  commandsDir: "./cli/commands",
});
