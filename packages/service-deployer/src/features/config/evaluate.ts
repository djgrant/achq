import { posix } from "node:path";
import { CONFIG_DIR, CONFIG_ENTRY, CORE_PLUGIN } from "@achq/core";
import { type ManifestInput, validateManifest } from "@achq/core/manifest";
import { errors } from "@achq/utils/errors";
import { type Limits, sandbox } from "./sandbox.ts";

export class ConfigError extends Error {}

export type Evaluate = (files: Record<string, string>) => Promise<ManifestInput>;

const LOADERS = { ts: "ts", mts: "ts", tsx: "tsx", js: "js", mjs: "js", json: "json" } as const;

/** Where `.achq/`, achq's own modules and the entry module sit in the sandbox's module names. */
const SANDBOX_ROOT = `/${CONFIG_DIR}`;
const SANDBOX_LIB = "/achq";
const SANDBOX_ENTRY = "/entry.js";

/**
 * What a config may import, by bare specifier, and the file each one means:
 * core and the plugins the infra installed for containers, e.g.
 * `{ "@achq/core": …, "@achq/github": …, "@achq/claude": … }`.
 */
export type ConfigModules = Record<string, string>;

const CONFIG_MODULE = `${SANDBOX_ROOT}/${CONFIG_ENTRY}`;

/** Where `modules` go in the sandbox, and the entry that imports the config, which declares its resources, then has core collect them. */
const layoutOf = (modules: ConfigModules) => {
  const entrypoints = Object.values(modules);
  // The directory every entrypoint is in, so each one's output keeps its own path under SANDBOX_LIB: there are several `index.ts`s.
  const root = entrypoints.map(posix.dirname).reduce((a, b) => {
    while (!`${b}/`.startsWith(`${a}/`)) a = posix.dirname(a);
    return a;
  });
  const sandboxPath = (entry: string) => posix.join(SANDBOX_LIB, posix.relative(root, entry).replace(/\.[a-z]+$/, ".js"));
  // What a config's bare imports resolve to: each package's entry module.
  const imports = Object.fromEntries(Object.entries(modules).map(([specifier, file]) => [specifier, sandboxPath(file)])) as Record<string, string>;
  return {
    entrypoints,
    root,
    imports,
    entry: `import "${CONFIG_MODULE}"; import { collectManifest } from "${imports[CORE_PLUGIN.package]}"; export default JSON.stringify(collectManifest());`,
  };
};

const LOG_LINES_QUOTED = 3;

/** A transpile error, as Bun throws it, with where in the file it is. */
type TranspileError = { message: string; position?: { line: number; column: number } };

const extOf = (path: string) => /\.([a-z]+)$/.exec(path)?.[1] as keyof typeof LOADERS | undefined;

/** The files evaluation reads; others under `.achq/` (the Dockerfile, prompts) aren't needed. */
export const isSourceFile = (path: string) => {
  const ext = extOf(path);
  return ext !== undefined && ext in LOADERS;
};

/** A repo-relative path, if it's plain: no absolute paths, `..`, backslashes or NULs. */
export const normaliseRepoPath = (path: string) => {
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/")) return undefined;
  const normal = posix.normalize(path);
  if (normal === "." || normal === ".." || normal.startsWith("../") || normal.startsWith("/")) return undefined;
  return normal;
};

const transpilers = new Map<string, Bun.Transpiler>();

/** A source file as a module. JSON becomes a default export. */
const transpile = (path: string, contents: string) => {
  const ext = extOf(path);
  if (ext === "json") return `export default ${JSON.stringify(JSON.parse(contents))};`;
  const loader = LOADERS[ext!];
  // `macro: false` refuses `with { type: "macro" }` imports. Without it the transpiler would run them here, on the host.
  if (!transpilers.has(loader)) transpilers.set(loader, new Bun.Transpiler({ loader, macro: false } as unknown as Bun.TranspilerOptions));
  return transpilers.get(loader)!.transformSync(contents);
};

const built = new Map<string, Promise<Record<string, string>>>();

/** The modules a config may import, built once for each set of them, with code splitting so they share their modules. */
const achqModules = ({ entrypoints, root }: ReturnType<typeof layoutOf>) => {
  const key = JSON.stringify(entrypoints);
  if (!built.has(key)) built.set(key, build(entrypoints, root));
  return built.get(key)!;
};

const build = async (entrypoints: string[], root: string) => {
  const result = await Bun.build({
    entrypoints,
    root,
    target: "browser",
    format: "esm",
    splitting: true,
    naming: { entry: "[dir]/[name].js", chunk: "chunk-[hash].js" },
  });
  if (!result.success) throw new AggregateError(result.logs, "Building achq for the sandbox failed");
  const out: Record<string, string> = {};
  for (const output of result.outputs) out[posix.join(SANDBOX_LIB, output.path)] = await output.text();
  return out;
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The config's manifest isn't valid JSON");
  }
};

/**
 * `files` are `.achq/`'s files, keyed by path relative to it (`config.ts`,
 * `lib/x.ts`). Other than source files, they're skipped. Its bare imports can
 * only be `allowed`'s.
 */
export const evaluateConfig = async (files: Record<string, string>, allowed: ConfigModules, limits: Partial<Limits> = {}) => {
  const layout = layoutOf(allowed);
  const modules = { ...(await achqModules(layout)) };
  for (const [path, contents] of Object.entries(files)) {
    const normal = normaliseRepoPath(path);
    if (!normal) throw new ConfigError(`${CONFIG_DIR}/${path} is not a valid path`);
    if (!isSourceFile(normal)) continue;
    try {
      modules[posix.join(SANDBOX_ROOT, normal)] = transpile(normal, contents);
    } catch (error) {
      const { message, position } = error as TranspileError;
      throw new ConfigError(`${CONFIG_DIR}/${normal}${position ? `:${position.line}:${position.column}` : ""}: ${message}`);
    }
  }
  if (!(CONFIG_MODULE in modules)) throw new ConfigError(`There's no ${CONFIG_DIR}/${CONFIG_ENTRY}`);
  modules[SANDBOX_ENTRY] = layout.entry;

  /** achq's own modules by name, and paths to the module they mean: the file itself, then with each extension, then its index. Anything else can't be imported. */
  const resolve = (specifier: string, importer: string) => {
    if (specifier in layout.imports) return layout.imports[specifier];
    if (!specifier.startsWith("./") && !specifier.startsWith("../") && !specifier.startsWith("/")) return undefined;
    const path = posix.normalize(specifier.startsWith("/") ? specifier : posix.join(posix.dirname(importer), specifier));
    return [path, ...Object.keys(LOADERS).flatMap((ext) => [`${path}.${ext}`, `${path}/index.${ext}`])].find((p) => p in modules);
  };

  const { result, logs } = await sandbox.run(SANDBOX_ENTRY, { modules, resolve, limits }).catch((error: Error) => {
    // The config's own module names, as `.achq/` paths, for errors people read.
    throw new ConfigError(`The config ${error.message.replaceAll(SANDBOX_ROOT, CONFIG_DIR)}`);
  });
  try {
    return validateManifest(parseJson(result));
  } catch (error) {
    const tail = logs.length ? ` (config logged: ${logs.slice(-LOG_LINES_QUOTED).join(" | ")})` : "";
    throw new ConfigError(`${errors.message(error)}${tail}`);
  }
};
