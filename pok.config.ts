import * as fs from "node:fs";
import { defineCommand, defineConfig, fromStatic, type CommandConfig } from "@pokit/core";
import { docs, release } from "pok-plugins";

/** Packages only this repo's tests use. */
const UNPUBLISHED = ["test-utils", "test-e2e"];

/**
 * The packages published to npm, in lockstep: every workspace package but the
 * tests'. They ship their TypeScript source, which Bun runs, so none has a
 * build. The services run from npm at the version that planned them, and
 * containers' Workers are built from it, so each version is published whole.
 */
const PUBLISHED = fs.readdirSync(new URL("./packages", import.meta.url)).sort().filter((dir) => !UNPUBLISHED.includes(dir) && fs.existsSync(new URL(`./packages/${dir}/package.json`, import.meta.url)));

/** `pok test` and `pok typecheck`: Bun runs the tests; tsc checks the packages, then core's and the plugins' sandboxed entries. */
const checks = fromStatic({
  test: defineCommand({
    label: "Run the tests",
    run: async (r) => {
      await r.exec("bun test");
    },
  }) as CommandConfig,
  typecheck: defineCommand({
    label: "Typecheck the packages",
    run: async (r) => {
      await r.exec("pnpm exec tsc");
      await r.exec("pnpm exec tsc -p tsconfig.sandbox.json");
    },
  }) as CommandConfig,
});

// Mounts `pok test` and `pok typecheck`, `pok docs dev|build|deploy`, which run `pnpm exec docs <cmd>` in ./docs,
// and `pok version` and `pok publish`.
// achq's own commands are in packages/cli, which has its own pok.config.ts.
export default defineConfig({
  appName: "achq",
  plugins: [
    checks,
    docs({ name: "achq-docs" }),
    release({
      packages: PUBLISHED.map((dir) => ({ file: `packages/${dir}/package.json`, build: false as const })),
    }),
  ],
});
