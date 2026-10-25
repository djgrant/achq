import { defineConfig } from "@pokit/core";
import { docs } from "pok-plugins";

// Mounts `pok docs dev|build|deploy`, which run `pnpm exec docs <cmd>` in ./docs.
// achq's own commands are in packages/cli, which has its own pok.config.ts.
export default defineConfig({
  appName: "achq",
  plugins: [docs({ name: "achq-docs" })],
});
