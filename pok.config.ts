import { defineConfig } from "@pokit/core";

// The global `pok` binary loads this when run inside the repo. `bin/achq` runs `pok` here from anywhere.
export default defineConfig({
  appName: "achq",
  commandsDir: "./cli/commands",
});
