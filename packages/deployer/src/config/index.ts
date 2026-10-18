// Evaluates a repo's `.achq/` without trusting it. Each file is transpiled on
// its own with macros off, so none of its code runs here. It runs in the
// sandbox, where a prebuilt achq is the only thing to import. The plan that
// comes back is checked strictly, since the config could have forged it.
import { posix } from "node:path";
import { type Limits, run } from "@achq/sandbox";
import type { RepoPlan } from "@achq/core";
import { parsePlan } from "./plan-schema.ts";

export { parsePlan } from "./plan-schema.ts";
export { DEFAULT_LIMITS, SandboxError, type Limits } from "@achq/sandbox";

export class ConfigError extends Error {}

export type Evaluate = (files: Record<string, string>) => Promise<RepoPlan>;

const LOADERS = { ts: "ts", mts: "ts", tsx: "tsx", js: "js", mjs: "js", json: "json" } as const;
type Ext = keyof typeof LOADERS;
const extOf = (path: string) => /\.([a-z]+)$/.exec(path)?.[1] as Ext | undefined;
/** The files evaluation reads; others under `.achq/` (the Dockerfile, prompts) aren't needed. */
export const isSourceFile = (path: string) => Boolean(extOf(path) && extOf(path)! in LOADERS);

/** A repo-relative path, if it's plain: no absolute paths, `..`, backslashes or NULs. */
export const normaliseRepoPath = (path: string): string | undefined => {
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/")) return undefined;
  const normal = posix.normalize(path);
  if (normal === "." || normal === ".." || normal.startsWith("../") || normal.startsWith("/")) return undefined;
  return normal;
};

const ROOT = "/.achq";
const LIB = "/achq";
const ENTRY = "/entry.js";
const BARE: Record<string, string> = { achq: `${LIB}/index.js`, "achq/github": `${LIB}/github.js` };

let lib: Promise<Record<string, string>> | undefined;
/** `achq` and `achq/github`, built with code splitting so they share one registry. */
const achqModules = () =>
  (lib ??= (async () => {
    const result = await Bun.build({
      entrypoints: [Bun.resolveSync("achq", import.meta.dir), Bun.resolveSync("achq/github", import.meta.dir), Bun.resolveSync("./plan.ts", import.meta.dir)],
      target: "browser",
      format: "esm",
      splitting: true,
      naming: { entry: "[name].js", chunk: "chunk-[hash].js" },
    });
    if (!result.success) throw new AggregateError(result.logs, "Building achq for the sandbox failed");
    const out: Record<string, string> = {};
    for (const output of result.outputs) out[posix.join(LIB, posix.basename(output.path))] = await output.text();
    return out;
  })());

const transpilers = new Map<string, Bun.Transpiler>();
const transpile = (path: string, contents: string): string => {
  const ext = extOf(path);
  if (ext === "json") return `export default ${JSON.stringify(JSON.parse(contents))};`;
  const loader = LOADERS[ext!];
  // `macro: false` refuses `with { type: "macro" }` imports. Without it the transpiler would run them here, on the host.
  if (!transpilers.has(loader)) transpilers.set(loader, new Bun.Transpiler({ loader, macro: false } as unknown as Bun.TranspilerOptions));
  return transpilers.get(loader)!.transformSync(contents);
};


/** `files` are `.achq/`'s files, keyed by path relative to it (`config.ts`, `lib/x.ts`). */
export const evaluateConfig = async (files: Record<string, string>, limits: Partial<Limits> = {}): Promise<RepoPlan> => {
  const modules: Record<string, string> = { ...(await achqModules()) };
  for (const [path, contents] of Object.entries(files)) {
    const normal = normaliseRepoPath(path);
    if (!normal) throw new ConfigError(`.achq/${path} is not a valid path`);
    if (!isSourceFile(normal)) continue;
    try {
      modules[posix.join(ROOT, normal)] = transpile(normal, contents);
    } catch (error) {
      const { message, position } = error as { message: string; position?: { line: number; column: number } };
      throw new ConfigError(`.achq/${normal}${position ? `:${position.line}:${position.column}` : ""}: ${message}`);
    }
  }
  if (!(`${ROOT}/config.ts` in modules)) throw new ConfigError("There's no .achq/config.ts");
  modules[ENTRY] = `import "${ROOT}/config.ts"; import plan from "${LIB}/plan.js"; export default plan();`;

  const resolve = (specifier: string, importer: string) => {
    if (specifier in BARE) return BARE[specifier];
    if (!specifier.startsWith("./") && !specifier.startsWith("../") && !specifier.startsWith("/")) return undefined;
    const path = posix.normalize(specifier.startsWith("/") ? specifier : posix.join(posix.dirname(importer), specifier));
    return [path, ...Object.keys(LOADERS).flatMap((e) => [`${path}.${e}`, `${path}/index.${e}`])].find((p) => p in modules);
  };

  const { result, logs } = await run(ENTRY, { modules, resolve, limits }).catch((error: Error) => {
    throw new ConfigError(`The config ${error.message.replaceAll(ROOT, ".achq")}`);
  });
  try {
    return parsePlan(result);
  } catch (error) {
    const tail = logs.length ? ` (config logged: ${logs.slice(-3).join(" | ")})` : "";
    throw new ConfigError(`${(error as Error).message}${tail}`);
  }
};
