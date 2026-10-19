import { posix } from "node:path";
import { CONFIG_MODULES } from "achq/registry";
import { SANDBOX_LIB } from "../constants.ts";

let lib: Promise<Record<string, string>> | undefined;

/** The modules a config may import, built with code splitting so they share one list of declarations, plus the plan entry. */
export const achqModules = () =>
  (lib ??= (async () => {
    const result = await Bun.build({
      entrypoints: [...CONFIG_MODULES.map((specifier) => Bun.resolveSync(specifier, import.meta.dir)), Bun.resolveSync("./plan.ts", import.meta.dir)],
      target: "browser",
      format: "esm",
      splitting: true,
      naming: { entry: "[name].js", chunk: "chunk-[hash].js" },
    });
    if (!result.success) throw new AggregateError(result.logs, "Building achq for the sandbox failed");
    const out: Record<string, string> = {};
    for (const output of result.outputs) out[posix.join(SANDBOX_LIB, posix.basename(output.path))] = await output.text();
    return out;
  })());
