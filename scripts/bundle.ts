// Bundles each published package into its dist/, which is all it publishes: its dependencies are in it, so
// installing it installs nothing else, and utils, which isn't published, is in each one that uses it, only
// as much as it uses. A package that others share at runtime, core, stays external. Runs before
// `pok publish`, and as `pok bundle`.
import * as fs from "node:fs";
import * as path from "node:path";
import { rolldown } from "rolldown";
import { dts } from "rolldown-plugin-dts";

const ROOT = path.join(import.meta.dir, "..");

/** Plugins and configs share the process's core, as installed beside them, so it's never bundled into them. */
const CORE = "@achq/core";

type Package = {
  /** Under packages/. */
  dir: string;
  /** Output file in dist/, by entry module in the package. A bin's starts with a shebang, as it's run directly. */
  entries: Record<string, { out: string; bin?: true }>;
  /** `browser` for what the config sandbox loads, or a Worker runs: core, and what it imports, has no Bun or Node. */
  target: "bun" | "browser";
  /** Imports left as they are: published packages it shares with whatever loads it, and the runtime's own modules. */
  external?: string[];
  /** Entry modules whose declarations it publishes, bundled the same way: what configs and infra files import. */
  types?: string[];
  /** Files copied into dist/: a module `specifier`, resolved from the package that depends on it (under packages/), as `out`. */
  copies?: { specifier: string; from: string; out: string }[];
  /** A bin that's a shell script, copied into dist/ with each `[from, to]` replaced, so it runs the bundle beside it. */
  script?: { bin: string; replace: [string, string][] };
};

/** A plugin's entries: what configs import, what the infra file imports, and what the services load. */
const plugin = (dir: string, entries: string[], types: string[]): Package => ({
  dir,
  entries: Object.fromEntries(entries.map((e) => [`src/${e}.ts`, { out: `${e}.js` }])),
  target: "bun",
  external: [CORE],
  types: types.map((t) => `src/${t}.ts`),
});

/** QuickJS loads its WebAssembly from beside the module that loads it, which is now the bundle. */
const QUICKJS = [{ specifier: "@jitl/quickjs-wasmfile-release-sync/wasm", from: "service-deployer", out: "emscripten-module.wasm" }];

export const PACKAGES: Package[] = [
  { dir: "core", entries: { "src/index.ts": { out: "index.js" } }, target: "browser", types: ["src/index.ts"] },
  plugin("plugin-github", ["index", "infra", "providers"], ["index", "infra"]),
  plugin("plugin-claude", ["index", "infra", "providers"], ["index", "infra"]),
  plugin("plugin-railway", ["infra", "providers"], ["infra"]),
  plugin("plugin-cloudflare", ["infra", "providers"], ["infra"]),
  plugin("plugin-1password", ["index"], ["index"]),
  { dir: "cloudflare-worker", entries: { "src/index.ts": { out: "index.js" } }, target: "browser", external: ["cloudflare:*"] },
  { dir: "service-router", entries: { "src/main.ts": { out: "achq-router.js", bin: true } }, target: "bun" },
  { dir: "service-deployer", entries: { "src/main.ts": { out: "achq-deployer.js", bin: true } }, target: "bun", copies: QUICKJS },
  {
    dir: "service-runner",
    entries: { "src/main.ts": { out: "main.js" } },
    target: "bun",
    // It runs main.js as the `agent` user.
    script: { bin: "bin/achq-runner", replace: [['/../src/main.ts"', '/main.js"']] },
  },
  {
    dir: "cli",
    entries: { "main.ts": { out: "achq.js", bin: true } },
    target: "bun",
    // It evaluates a repo's config in the deployer's sandbox.
    copies: QUICKJS,
  },
];

/** Marks exactly `external`'s specifiers external: a subpath of one, e.g. `@achq/core/protocol`, isn't published, so it's bundled. */
const exactly = (external: string[]): Bun.BunPlugin => ({
  name: "exactly-external",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => (external.some((e) => (e.endsWith("*") ? args.path.startsWith(e.slice(0, -1)) : args.path === e)) ? { path: args.path, external: true } : undefined));
  },
});

const bundleJs = async (pkg: string, dist: string, { entries, target, external = [] }: Package) => {
  const result = await Bun.build({
    entrypoints: Object.keys(entries).map((e) => path.join(pkg, e)),
    root: path.dirname(path.join(pkg, Object.keys(entries)[0]!)),
    outdir: dist,
    target,
    format: "esm",
    // Entries share their modules, e.g. a plugin's resources and its providers, so each is loaded once.
    splitting: Object.keys(entries).length > 1,
    naming: { entry: "[name].js", chunk: "chunk-[hash].js" },
    minify: true,
    sourcemap: "linked",
    plugins: [exactly(external)],
  });
  if (!result.success) throw new AggregateError(result.logs, `Bundling ${path.relative(ROOT, pkg)} failed`);
  // Bun names an entry's output by its module's name; a bin is renamed, and gets its shebang.
  for (const [entry, { out, bin }] of Object.entries(entries)) {
    const built = path.join(dist, `${path.basename(entry, path.extname(entry))}.js`);
    if (built !== path.join(dist, out)) {
      fs.renameSync(built, path.join(dist, out));
      fs.renameSync(`${built}.map`, path.join(dist, `${out}.map`));
      fs.writeFileSync(path.join(dist, out), fs.readFileSync(path.join(dist, out), "utf8").replace(`//# sourceMappingURL=${path.basename(built)}.map`, `//# sourceMappingURL=${out}.map`));
    }
    if (bin) {
      fs.writeFileSync(path.join(dist, out), `#!/usr/bin/env bun\n${fs.readFileSync(path.join(dist, out), "utf8")}`);
      fs.chmodSync(path.join(dist, out), 0o755);
    }
  }
};

/** Declarations, bundled from TypeScript's: only what the entries' types refer to, with utils' inlined. Declarations have no side effects, so an import nothing uses goes. */
const bundleTypes = async (pkg: string, dist: string, { types = [], external = [] }: Package) => {
  if (!types.length) return;
  const bundle = await rolldown({
    input: Object.fromEntries(types.map((t) => [path.basename(t, ".ts"), path.join(pkg, t)])),
    cwd: ROOT,
    external: (id) => external.includes(id) || (!id.startsWith("@achq/") && !id.startsWith(".") && !path.isAbsolute(id)),
    treeshake: { moduleSideEffects: false },
    plugins: [dts({ emitDtsOnly: true, tsconfig: path.join(ROOT, "tsconfig.json"), logger: { info: () => {}, warn: console.warn, error: console.error } })],
  });
  await bundle.write({ dir: dist, format: "esm" });
};

export const bundle = async (p: Package) => {
  const pkg = path.join(ROOT, "packages", p.dir);
  const dist = path.join(pkg, "dist");
  fs.rmSync(dist, { recursive: true, force: true });
  await bundleJs(pkg, dist, p);
  await bundleTypes(pkg, dist, p);
  for (const { specifier, from, out } of p.copies ?? []) fs.copyFileSync(Bun.resolveSync(specifier, path.join(ROOT, "packages", from)), path.join(dist, out));
  if (p.script) {
    let script = fs.readFileSync(path.join(pkg, p.script.bin), "utf8");
    for (const [from, to] of p.script.replace) {
      if (!script.includes(from)) throw new Error(`${p.dir}/${p.script.bin} no longer has ${from}`);
      script = script.replace(from, to);
    }
    fs.writeFileSync(path.join(dist, path.basename(p.script.bin)), script, { mode: 0o755 });
  }
  return dist;
};

if (import.meta.main) {
  for (const p of PACKAGES) {
    const dist = await bundle(p);
    const sizes = fs.readdirSync(dist).filter((f) => !f.endsWith(".map")).map((f) => `${f} ${Math.round(fs.statSync(path.join(dist, f)).size / 1024)} KB`);
    console.log(`${p.dir}: ${sizes.join(", ")}`);
  }
}
