// Evaluates a repo's `.achq/` without trusting it. Each file is transpiled on
// its own with macros off, so none of its code runs here. It runs in the
// sandbox, where a prebuilt achq is the only thing to import. The manifest that
// comes back is checked strictly, since the config could have forged it.
import { posix } from "node:path";
import { type Limits, run } from "@achq/sandbox";
import type { RepoManifest } from "@achq/core";
import { LOADERS, SANDBOX_ENTRY, SANDBOX_IMPORTS, SANDBOX_LIB, SANDBOX_ROOT } from "../constants.ts";
import { achqModules } from "./library.ts";
import { isSourceFile, normaliseRepoPath } from "./paths.ts";
import { parseManifest } from "./manifest-schema.ts";
import { transpile } from "./transpile.ts";

export class ConfigError extends Error {}

export type Evaluate = (files: Record<string, string>) => Promise<RepoManifest>;

/** `files` are `.achq/`'s files, keyed by path relative to it (`config.ts`, `lib/x.ts`). */
export const evaluateConfig = async (files: Record<string, string>, limits: Partial<Limits> = {}): Promise<RepoManifest> => {
  const modules: Record<string, string> = { ...(await achqModules()) };
  for (const [path, contents] of Object.entries(files)) {
    const normal = normaliseRepoPath(path);
    if (!normal) throw new ConfigError(`.achq/${path} is not a valid path`);
    if (!isSourceFile(normal)) continue;
    try {
      modules[posix.join(SANDBOX_ROOT, normal)] = transpile(normal, contents);
    } catch (error) {
      const { message, position } = error as { message: string; position?: { line: number; column: number } };
      throw new ConfigError(`.achq/${normal}${position ? `:${position.line}:${position.column}` : ""}: ${message}`);
    }
  }
  if (!(`${SANDBOX_ROOT}/config.ts` in modules)) throw new ConfigError("There's no .achq/config.ts");
  modules[SANDBOX_ENTRY] = `import "${SANDBOX_ROOT}/config.ts"; import manifest from "${SANDBOX_LIB}/manifest.js"; export default manifest();`;

  const resolve = (specifier: string, importer: string) => {
    if (specifier in SANDBOX_IMPORTS) return SANDBOX_IMPORTS[specifier];
    if (!specifier.startsWith("./") && !specifier.startsWith("../") && !specifier.startsWith("/")) return undefined;
    const path = posix.normalize(specifier.startsWith("/") ? specifier : posix.join(posix.dirname(importer), specifier));
    return [path, ...Object.keys(LOADERS).flatMap((e) => [`${path}.${e}`, `${path}/index.${e}`])].find((p) => p in modules);
  };

  const { result, logs } = await run(SANDBOX_ENTRY, { modules, resolve, limits }).catch((error: Error) => {
    throw new ConfigError(`The config ${error.message.replaceAll(SANDBOX_ROOT, ".achq")}`);
  });
  try {
    return parseManifest(result);
  } catch (error) {
    const tail = logs.length ? ` (config logged: ${logs.slice(-3).join(" | ")})` : "";
    throw new ConfigError(`${(error as Error).message}${tail}`);
  }
};
