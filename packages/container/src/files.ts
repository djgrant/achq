import * as fs from "node:fs";
import * as path from "node:path";
import type { Data } from "@achq/core";
import { inRoot } from "./config/path.ts";

/**
 * Startup files' contents: a string value is a file in `.achq/`, anything else
 * is written as JSON. Keys are the target paths, as declared.
 */
export const resolveFiles = (files: Record<string, unknown> | undefined, root: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [target, value] of Object.entries(files ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    out[target] = typeof value === "string" ? fs.readFileSync(inRoot(root, value), "utf8") : `${JSON.stringify(value as Data, null, 2)}\n`;
  }
  return out;
};

/** Where a startup file goes: `~/…` and relative paths under `home`, absolute paths as they are. */
export const targetPath = (key: string, home: string) => {
  if (key.startsWith("~/")) return path.join(home, key.slice(2));
  return path.isAbsolute(key) ? key : path.join(home, key);
};

export const writeFiles = (resolved: Record<string, string>, home: string) => {
  for (const [key, content] of Object.entries(resolved)) {
    const file = targetPath(key, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
};
