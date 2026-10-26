import { defineConfig } from "@pokit/core";
import { docs, release } from "pok-plugins";

/** The packages published to npm, in lockstep. They ship their TypeScript source, which Bun runs, so none has a build. */
const PUBLISHED = ["utils", "core", "cloudflare-worker", "plugin-github", "plugin-claude", "plugin-cloudflare", "plugin-railway", "plugin-1password", "registry", "service-deployer", "cli"];

// Mounts `pok docs dev|build|deploy`, which run `pnpm exec docs <cmd>` in ./docs,
// and `pok version` and `pok publish`.
// achq's own commands are in packages/cli, which has its own pok.config.ts.
export default defineConfig({
  appName: "achq",
  plugins: [
    docs({ name: "achq-docs" }),
    release({
      packages: PUBLISHED.map((dir) => ({ file: `packages/${dir}/package.json`, build: false as const })),
    }),
  ],
});
