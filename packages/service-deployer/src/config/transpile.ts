import { LOADERS } from "../constants.ts";
import { extOf } from "./paths.ts";

const transpilers = new Map<string, Bun.Transpiler>();

/** JSON becomes a default export. */
export const transpile = (path: string, contents: string): string => {
  const ext = extOf(path);
  if (ext === "json") return `export default ${JSON.stringify(JSON.parse(contents))};`;
  const loader = LOADERS[ext!];
  // `macro: false` refuses `with { type: "macro" }` imports. Without it the transpiler would run them here, on the host.
  if (!transpilers.has(loader)) transpilers.set(loader, new Bun.Transpiler({ loader, macro: false } as unknown as Bun.TranspilerOptions));
  return transpilers.get(loader)!.transformSync(contents);
};
