import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_MODULES } from "achq/registry";

/** What a config's bare imports resolve to. */
const MODULES: Record<string, string> = Object.fromEntries(CONFIG_MODULES.map((specifier) => [specifier, Bun.resolveSync(specifier, import.meta.dir)]));
const ALLOWED = `${CONFIG_MODULES.join(", ")} and its own files`;

/** Bundles `.achq/config.ts`, refusing imports other than CONFIG_MODULES and files in `.achq/`. */
export const bundleConfig = async (root: string, outdir: string) => {
  const entry = path.join(root, "config.ts");
  if (!fs.existsSync(entry)) throw new Error("There's no .achq/config.ts");
  const modules = MODULES;
  const real = fs.realpathSync(root);
  const result = await Bun.build({
    entrypoints: [entry],
    outdir,
    target: "bun",
    format: "esm",
    plugins: [
      {
        name: "achq-config",
        setup(build) {
          // achq stays external, so the config declares its resources in the
          // same module instance the runner reads them from.
          build.onResolve({ filter: /^[^./]/ }, (args) => {
            const target = modules[args.path];
            if (!target) throw new Error(`.achq/ can only import ${ALLOWED}, not "${args.path}"`);
            return { path: target, external: true };
          });
          build.onResolve({ filter: /^\.\.?\// }, (args) => {
            const file = path.resolve(path.dirname(fs.realpathSync(args.importer)), args.path);
            if (!file.startsWith(real + path.sep)) throw new Error(`.achq/ can only import its own files, not "${args.path}"`);
            return undefined;
          });
        },
      },
    ],
  });
  if (!result.success) throw new AggregateError(result.logs, "Bundling .achq/config.ts failed");
  const bundle = result.outputs[0]!.path;
  // Builtins (`node:fs`, `bun`) skip resolve plugins, so check what the bundle still imports.
  const allowed = new Set(Object.values(modules));
  const imports = new Bun.Transpiler({ loader: "js" }).scanImports(fs.readFileSync(bundle, "utf8"));
  const refused = imports.map((i) => i.path).filter((p) => !allowed.has(p));
  if (refused.length) throw new Error(`.achq/ can only import ${ALLOWED}, not ${refused.map((p) => `"${p}"`).join(", ")}`);
  return bundle;
};
