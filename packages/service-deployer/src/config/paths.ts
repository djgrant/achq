import { posix } from "node:path";
import { LOADERS } from "../constants.ts";

export type Ext = keyof typeof LOADERS;

export const extOf = (path: string) => /\.([a-z]+)$/.exec(path)?.[1] as Ext | undefined;

/** The files evaluation reads; others under `.achq/` (the Dockerfile, prompts) aren't needed. */
export const isSourceFile = (path: string) => {
  const ext = extOf(path);
  return ext !== undefined && ext in LOADERS;
};

/** A repo-relative path, if it's plain: no absolute paths, `..`, backslashes or NULs. */
export const normaliseRepoPath = (path: string): string | undefined => {
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/")) return undefined;
  const normal = posix.normalize(path);
  if (normal === "." || normal === ".." || normal.startsWith("../") || normal.startsWith("/")) return undefined;
  return normal;
};
