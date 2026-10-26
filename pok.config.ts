import * as fs from "node:fs";
import { defineCommand, defineConfig, fromStatic, type CommandConfig } from "@pokit/core";
import { docs, release } from "pok-plugins";

type Manifest = { private?: boolean; files?: string[] };

const manifestOf = (dir: string): Manifest | undefined => {
  const file = new URL(`./packages/${dir}/package.json`, import.meta.url);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
};

/**
 * The packages published to npm, in lockstep: every workspace package that
 * isn't private. utils and the tests' aren't: utils is bundled into what uses
 * it. The services run from npm at the version that planned them, and
 * containers' Workers are built from it, so each version is published whole.
 */
const PUBLISHED = fs.readdirSync(new URL("./packages", import.meta.url)).sort().filter((dir) => {
  const manifest = manifestOf(dir);
  return manifest !== undefined && !manifest.private;
});

/** Bundles each published package into its dist/. */
const BUNDLE = "bun scripts/bundle.ts";

/** A package that publishes its dist/ is bundled first: every published package, which the bundle script lists. */
const buildOf = (dir: string) => (manifestOf(dir)?.files?.includes("dist") ? BUNDLE : (false as const));

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
    label: "Bundle the published packages, as they're published",
    run: async (r) => {
      await r.exec(BUNDLE);
    },
  }) as CommandConfig,
});

// Mounts `pok test`, `pok typecheck` and `pok bundle`, `pok docs dev|build|deploy`, which run `pnpm exec docs <cmd>` in ./docs,
// and `pok version` and `pok publish`, which bundles the packages before it publishes.
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
