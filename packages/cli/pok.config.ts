import { defineConfig } from "@pokit/core";

// Only the global `pok` binary reads this. `bin/achq` runs src/main.ts, which needs no global `pok`.
export default defineConfig({
  appName: "achq",
  commandsDir: "./src/commands",
});
