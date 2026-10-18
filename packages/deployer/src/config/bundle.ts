// Bundles a repo's `.achq/` into one script, without running any of it.
//
// Nothing is read from disk on the repo's behalf: its files are served from
// memory under a virtual root, and every import is resolved here. The only
// on-disk modules a bundle can contain are achq's own (`achq`, `achq/github`
// and what they import within src/). Macros are off (`macros: false`), so
// bundling never executes the repo's code.
import { dirname, posix, resolve as resolvePath, sep } from "node:path";
import type { BunPlugin } from "bun";

const SRC = resolvePath(import.meta.dir, "../../..");
const ALIASES: Record<string, string> = {
  achq: Bun.resolveSync("achq", import.meta.dir),
  "achq/github": Bun.resolveSync("achq/github", import.meta.dir),
};
const RESOURCES = Bun.resolveSync("@achq/core", import.meta.dir);

/** Where the repo's files appear to live. Never touches the filesystem. */
const ROOT = "/.achq";
const REPO_NS = "achq-repo";
const ENTRY = "/achq-entry.ts";
const ENTRY_NS = "achq-entry";

const LOADERS = { ts: "ts", mts: "ts", tsx: "tsx", js: "js", mjs: "js", json: "json" } as const;
type Ext = keyof typeof LOADERS;
const extOf = (path: string) => /\.([a-z]+)$/.exec(path)?.[1] as Ext | undefined;
/** The extensions the bundler loads; other files under `.achq/` aren't needed to evaluate config. */
export const isSourceFile = (path: string) => Boolean(extOf(path) && extOf(path)! in LOADERS);

export class ConfigError extends Error {}

/** Checks a repo-relative path is plain: no absolute paths, `..`, backslashes or NULs. */
export const normaliseRepoPath = (path: string): string | undefined => {
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/")) return undefined;
  const normal = posix.normalize(path);
  if (normal === "." || normal.startsWith("../") || normal === ".." || normal.startsWith("/")) return undefined;
  return normal;
};

const within = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** Bundles `config.ts` (paths relative to `.achq/`) into a script that leaves the plan's JSON in `globalThis.__achqPlan`. */
export const bundleConfig = async (files: Record<string, string>): Promise<string> => {
  const repo = new Map<string, string>();
  for (const [path, contents] of Object.entries(files)) {
    const normal = normaliseRepoPath(path);
    if (!normal) throw new ConfigError(`.achq/${path} is not a valid path`);
    repo.set(posix.join(ROOT, normal), contents);
  }
  if (!repo.has(`${ROOT}/config.ts`)) throw new ConfigError("There's no .achq/config.ts");

  const resolveInRepo = (specifier: string, importer: string) => {
    const path = posix.normalize(posix.join(posix.dirname(importer), specifier));
    if (!within(path, ROOT)) throw new ConfigError(`${shown(importer)} imports "${specifier}", which is outside .achq/`);
    const found = [path, ...Object.keys(LOADERS).map((e) => `${path}.${e}`), ...Object.keys(LOADERS).map((e) => `${path}/index.${e}`)].find((p) =>
      repo.has(p),
    );
    if (!found) throw new ConfigError(`${shown(importer)} imports "${specifier}", which isn't a file in .achq/`);
    return found;
  };
  const shown = (importer: string) => (importer.startsWith(ROOT) ? `.achq${importer.slice(ROOT.length)}` : importer === ENTRY ? "config" : importer);

  const plugin: BunPlugin = {
    name: "achq-sandbox",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const { path: specifier, importer, namespace } = args;
        if (args.kind === "entry-point-build") return { path: ENTRY, namespace: ENTRY_NS };
        if (specifier in ALIASES) return { path: ALIASES[specifier], namespace: "file" };
        const fromRepo = namespace === REPO_NS || namespace === ENTRY_NS || importer.startsWith(ROOT) || importer === ENTRY;
        if (fromRepo) {
          if (importer === ENTRY && specifier === RESOURCES) return { path: RESOURCES, namespace: "file" };
          if (!specifier.startsWith("./") && !specifier.startsWith("../"))
            throw new ConfigError(`${shown(importer)} imports "${specifier}": config can only import "achq", "achq/github" and its own files under .achq/`);
          return { path: resolveInRepo(specifier, importer === ENTRY ? `${ROOT}/config.ts` : importer), namespace: REPO_NS };
        }
        // achq's own modules: relative imports and achq packages, within packages/.
        if (within(importer, SRC) && (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("@achq/"))) {
          const path = specifier.startsWith("@achq/") ? Bun.resolveSync(specifier, dirname(importer)) : resolvePath(dirname(importer), specifier);
          if (within(path, SRC)) return { path, namespace: "file" };
        }
        throw new ConfigError(`achq module ${importer} imports "${specifier}", which the config sandbox doesn't allow`);
      });
      build.onLoad({ filter: /.*/, namespace: ENTRY_NS }, () => ({
        loader: "ts",
        contents: [
          `import "./config.ts";`,
          `import { collectPlan } from ${JSON.stringify(RESOURCES)};`,
          `globalThis.__achqPlan = JSON.stringify(collectPlan());`,
        ].join("\n"),
      }));
      build.onLoad({ filter: /.*/, namespace: REPO_NS }, (args) => {
        const contents = repo.get(args.path);
        const ext = extOf(args.path);
        if (contents === undefined || !ext || !(ext in LOADERS)) throw new ConfigError(`.achq${args.path.slice(ROOT.length)} can't be imported`);
        return { contents, loader: LOADERS[ext] };
      });
    },
  };

  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    result = await Bun.build({
      entrypoints: [ENTRY],
      plugins: [plugin],
      target: "browser",
      format: "iife",
      // Not in bun-types, but Bun.build reads it: with it, any `with { type: "macro" }`
      // import fails the build ("Macros are disabled") instead of running at bundle time.
      // sandbox.test.ts proves it, so a Bun upgrade that drops it fails the tests.
      macros: false,
      packages: "bundle",
      throw: true,
      env: "disable",
      define: { "process.env.NODE_ENV": '"production"' },
    } as Parameters<typeof Bun.build>[0]);
  } catch (error) {
    throw new ConfigError(`Bundling .achq/config.ts failed: ${buildMessage(error)}`);
  }
  if (!result.success || result.outputs.length !== 1) throw new ConfigError(`Bundling .achq/config.ts failed: ${result.logs.map(String).join("; ")}`);
  return result.outputs[0]!.text();
};

const buildMessage = (error: unknown): string => {
  if (error instanceof ConfigError) return error.message;
  const errors = (error as { errors?: unknown[] })?.errors;
  if (Array.isArray(errors) && errors.length) {
    return errors
      .map((e) => {
        const { message, position } = e as { message?: string; position?: { file?: string; line?: number; column?: number } | null };
        const where = position?.file && position.line ? ` (${position.file.replace(/^achq-repo:/, "").replace(ROOT, ".achq")}:${position.line}:${position.column})` : "";
        return `${message ?? String(e)}${where}`;
      })
      .join("; ");
  }
  return error instanceof Error ? error.message : String(error);
};
