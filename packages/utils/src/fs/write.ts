// Writing files so that a reader, or a restart after a crash, sees the old
// content or the new, never half of either: write a temp file, then rename it
// over the target, which is atomic on one filesystem.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomHex } from "../crypto.ts";

export type WriteOptions = { mode?: number };

/** Whether `e` is the error for a missing file or directory. */
export const isNotFound = (e: unknown): boolean => (e as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

/** Unique per process and write, so concurrent writers never share a temp file. */
const tempFor = (file: string) => `${file}.${process.pid}.${randomHex(4)}.tmp`;

/** Replaces `file` with `data` in one step. Its directory must exist. */
export const writeFileAtomic = async (file: string, data: string, { mode }: WriteOptions = {}) => {
  const tmp = tempFor(file);
  await fsp.writeFile(tmp, data, { mode });
  await fsp.rename(tmp, file);
};

/** `writeFileAtomic`, synchronously. */
export const writeFileAtomicSync = (file: string, data: string, { mode }: WriteOptions = {}) => {
  const tmp = tempFor(file);
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
};

/** Creates `dir` and its parents if they're missing. */
export const ensureDir = (dir: string, { mode }: WriteOptions = {}) => {
  fs.mkdirSync(dir, { recursive: true, mode });
};

/** Creates each of `dirs` and their parents if they're missing. */
export const ensureDirs = (...dirs: string[]) => {
  for (const dir of dirs) ensureDir(dir);
};

/** Writes `file`, creating its directory first. `dirMode` applies to directories it creates. */
export const writeFileEnsured = (file: string, data: string, { mode, dirMode }: WriteOptions & { dirMode?: number } = {}) => {
  ensureDir(path.dirname(file), { mode: dirMode });
  fs.writeFileSync(file, data, { mode });
};

/** Creates an empty `file`, or returns false if it already exists. Atomic, so of racing callers exactly one gets true. */
export const createExclusive = (file: string): boolean => {
  try {
    fs.writeFileSync(file, "", { flag: "wx" });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
};
