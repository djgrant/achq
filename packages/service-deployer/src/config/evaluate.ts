// Evaluates a repo's `.achq/` without trusting it. Each file is transpiled on
// its own with macros off, so none of its code runs here. It runs in the
// sandbox, where a prebuilt achq is the only thing to import. The manifest that
// comes back is checked strictly, since the config could have forged it.
import { posix } from "node:path";
import { type Limits, run } from "@achq/utils/sandbox";
import type { RepoManifest } from "@achq/core";
import { LOADERS, SANDBOX_ENTRY, SANDBOX_IMPORTS, SANDBOX_LIB, SANDBOX_ROOT } from "../constants.ts";
import { achqModules } from "./library.ts";
import { isSourceFile, normaliseRepoPath } from "./paths.ts";
import { parseManifest } from "./manifest-schema.ts";
import { transpile } from "./transpile.ts";

export class ConfigError extends Error {}

export type Evaluate = (files: Record<string, string>) => Promise<RepoManifest>;

/** Sandbox module source, by module name. */
type Modules = Record<string, string>;

/** How many of the config's last log lines a manifest error quotes. */
const LOG_LINES_QUOTED = 3;

const CONFIG_MODULE = `${SANDBOX_ROOT}/config.ts`;
/** Imports the config, which declares its resources, then collects them. */
const ENTRY_SOURCE = `import "${CONFIG_MODULE}"; import manifest from "${SANDBOX_LIB}/manifest.js"; export default manifest();`;

/** A transpile error, as Bun throws it, with where in the file it is. */
type TranspileError = { message: string; position?: { line: number; column: number } };

const transpileError = (path: string, error: unknown) => {
  const { message, position } = error as TranspileError;
  return new ConfigError(`.achq/${path}${position ? `:${position.line}:${position.column}` : ""}: ${message}`);
};

/** `.achq/`'s source files as sandbox modules under SANDBOX_ROOT. Other files are skipped; a path that isn't plain throws. */
const configModules = (files: Record<string, string>): Modules => {
  const modules: Modules = {};
  for (const [path, contents] of Object.entries(files)) {
    const normal = normaliseRepoPath(path);
    if (!normal) throw new ConfigError(`.achq/${path} is not a valid path`);
    if (!isSourceFile(normal)) continue;
    try {
      modules[posix.join(SANDBOX_ROOT, normal)] = transpile(normal, contents);
    } catch (error) {
      throw transpileError(normal, error);
    }
  }
  return modules;
};

/** Whether an import names a file, relatively or absolutely, rather than a package. */
const isPathSpecifier = (specifier: string) => specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/");

/** What an import of `path` may mean, in the order they're tried: the file itself, then with each extension, then its index. */
const candidatePaths = (path: string) => [path, ...Object.keys(LOADERS).flatMap((ext) => [`${path}.${ext}`, `${path}/index.${ext}`])];

/** Resolves achq's own modules by name, and paths to the module they mean. Anything else can't be imported. */
const resolverFor = (modules: Modules) => (specifier: string, importer: string) => {
  if (specifier in SANDBOX_IMPORTS) return SANDBOX_IMPORTS[specifier];
  if (!isPathSpecifier(specifier)) return undefined;
  const path = posix.normalize(specifier.startsWith("/") ? specifier : posix.join(posix.dirname(importer), specifier));
  return candidatePaths(path).find((p) => p in modules);
};

/** The config's own module names, as `.achq/` paths, for errors people read. */
const asConfigPaths = (message: string) => message.replaceAll(SANDBOX_ROOT, ".achq");

/** `files` are `.achq/`'s files, keyed by path relative to it (`config.ts`, `lib/x.ts`). */
export const evaluateConfig = async (files: Record<string, string>, limits: Partial<Limits> = {}): Promise<RepoManifest> => {
  const modules: Modules = { ...(await achqModules()), ...configModules(files) };
  if (!(CONFIG_MODULE in modules)) throw new ConfigError("There's no .achq/config.ts");
  modules[SANDBOX_ENTRY] = ENTRY_SOURCE;

  const { result, logs } = await run(SANDBOX_ENTRY, { modules, resolve: resolverFor(modules), limits }).catch((error: Error) => {
    throw new ConfigError(`The config ${asConfigPaths(error.message)}`);
  });
  try {
    return parseManifest(result);
  } catch (error) {
    const tail = logs.length ? ` (config logged: ${logs.slice(-LOG_LINES_QUOTED).join(" | ")})` : "";
    throw new ConfigError(`${(error as Error).message}${tail}`);
  }
};
