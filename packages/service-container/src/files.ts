import * as fs from "node:fs";
import * as path from "node:path";
import { collections } from "@achq/utils/collections";
import { disk } from "@achq/utils/disk";
import { inRoot } from "./config/path.ts";

/**
 * Startup files' contents: a string value is a file in `.achq/`, anything else
 * is written as JSON. Keys are the target paths, as declared.
 */
export const resolveFiles = (files: Record<string, unknown> | undefined, root: string): Record<string, string> => {
  const contentOf = (value: unknown) => (typeof value === "string" ? fs.readFileSync(inRoot(root, value), "utf8") : `${JSON.stringify(value, null, 2)}\n`);
  return collections.mapValues(collections.sortKeys(files ?? {}), contentOf);
};

/** Where a startup file goes: `~/…` and relative paths under `home`, absolute paths as they are. */
export const targetPath = (key: string, home: string) => {
  if (key.startsWith("~/")) return path.join(home, key.slice(2));
  return path.isAbsolute(key) ? key : path.join(home, key);
};

export const writeFiles = (resolved: Record<string, string>, home: string) => {
  for (const [key, content] of Object.entries(resolved)) disk.writeEnsured(targetPath(key, home), content);
};
