import * as fs from "node:fs";
import { defineCommand, defineConfig, fromStatic, type CommandConfig } from "@pokit/core";
import { docs, release } from "pok-plugins";

/** Packages only this repo's tests use. */
const UNPUBLISHED = ["test-utils", "test-e2e"];

/**
 * The packages published to npm, in lockstep: every workspace package but the
 * tests'. The services run from npm at the version that planned them, and
 * containers' Workers are built from it, so each version is published whole.
 */
const PUBLISHED = fs.readdirSync(new URL("./packages", import.meta.url)).sort().filter((dir) => !UNPUBLISHED.includes(dir) && fs.existsSync(new URL(`./packages/${dir}/package.json`, import.meta.url)));

/** Bundles the services into their dist/. */
const BUNDLE = "bun scripts/bundle.ts";

/**
 * A package that publishes its dist/ (the services) is bundled first. The rest
 * ship their TypeScript source, which Bun runs: the plugins, core and utils
 * are installed beside each other, so a plugin shares the process's core.
 */
const buildOf = (dir: string) => {
  const { files } = JSON.parse(fs.readFileSync(new URL(`./packages/${dir}/package.json`, import.meta.url), "utf8")) as { files?: string[] };
  return files?.includes("dist") ? BUNDLE : (false as const);
};

/** `pok test`, `pok typecheck` and `pok bundle`: Bun runs the tests; tsc checks the packages, then core's and the plugins' sandboxed entries. */
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
  bundle: defineCommand({
    label: "Bundle the services, as they're published",
    run: async (r) => {
      await r.exec(BUNDLE);
    },
  }) as CommandConfig,
});

// Mounts `pok test`, `pok typecheck` and `pok bundle`, `pok docs dev|build|deploy`, which run `pnpm exec docs <cmd>` in ./docs,
// and `pok version` and `pok publish`, which bundles the services before it publishes.
// achq's own commands are in packages/cli, which has its own pok.config.ts.
export default defineConfig({
  appName: "achq",
  plugins: [
    checks,
    docs({ name: "achq-docs" }),
    release({
      packages: PUBLISHED.map((dir) => ({ file: `packages/${dir}/package.json`, build: buildOf(dir) })),
    }),
  ],
});
