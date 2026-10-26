// Bundles the services into each one's dist/, which is all they publish: `bunx @achq/<service>@<version>`
// then installs one package, not its dependencies. Runs before `pok publish`, and as `pok bundle`.
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.join(import.meta.dir, "..");

type Bundle = {
  /** Under packages/. */
  dir: string;
  /** Output file in dist/, by entry module in the package. A bin's starts with a shebang, as bunx runs it directly. */
  entries: Record<string, { out: string; bin?: true }>;
  /** Files copied into dist/, by where they're resolved from in the package. */
  copies?: Record<string, string>;
};

export const BUNDLES: Bundle[] = [
  { dir: "service-router", entries: { "src/main.ts": { out: "achq-router.js", bin: true } } },
  {
    dir: "service-deployer",
    entries: { "src/main.ts": { out: "achq-deployer.js", bin: true }, "src/features/config/evaluate.ts": { out: "config.js" } },
    // QuickJS loads its WebAssembly from beside the module that loads it, which is now the bundle.
    copies: { "@jitl/quickjs-wasmfile-release-sync/wasm": "emscripten-module.wasm" },
  },
  // Its bin is achq-runner, below, which runs main.js.
  { dir: "service-runner", entries: { "src/main.ts": { out: "main.js" } } },
];

/** The runner's bin is a shell script, which runs its entry module as the `agent` user. Published, that's the bundle. */
const RUNNER_ENTRY = `"$(dirname "$(readlink -f "$0")")/../src/main.ts"`;

const bundle = async ({ dir, entries, copies = {} }: Bundle) => {
  const pkg = path.join(ROOT, "packages", dir);
  const dist = path.join(pkg, "dist");
  fs.rmSync(dist, { recursive: true, force: true });
  for (const [entry, { out, bin }] of Object.entries(entries)) {
    const result = await Bun.build({
      entrypoints: [path.join(pkg, entry)],
      target: "bun",
      format: "esm",
      minify: true,
      sourcemap: "linked",
      ...(bin && { banner: "#!/usr/bin/env bun" }),
      naming: out,
      outdir: dist,
    });
    if (!result.success) throw new AggregateError(result.logs, `Bundling ${dir}/${entry} failed`);
  }
  for (const [specifier, out] of Object.entries(copies)) fs.copyFileSync(Bun.resolveSync(specifier, pkg), path.join(dist, out));
  if (dir === "service-runner") {
    const script = fs.readFileSync(path.join(pkg, "bin", "achq-runner"), "utf8");
    if (!script.includes(RUNNER_ENTRY)) throw new Error(`service-runner/bin/achq-runner no longer runs ${RUNNER_ENTRY}`);
    fs.writeFileSync(path.join(dist, "achq-runner"), script.replace(RUNNER_ENTRY, `"$(dirname "$(readlink -f "$0")")/main.js"`), { mode: 0o755 });
  }
  for (const { out, bin } of Object.values(entries)) if (bin) fs.chmodSync(path.join(dist, out), 0o755);
  return dist;
};

if (import.meta.main) {
  for (const b of BUNDLES) {
    const dist = await bundle(b);
    const sizes = fs.readdirSync(dist).filter((f) => !f.endsWith(".map")).map((f) => `${f} ${Math.round(fs.statSync(path.join(dist, f)).size / 1024)} KB`);
    console.log(`${b.dir}: ${sizes.join(", ")}`);
  }
}

export { bundle };
