import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomHex } from "../crypto.ts";

export type WriteOptions = { mode?: number };

export const isNotFound = (e: unknown): boolean => (e as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

/** Unique per process and write, so concurrent writers never share a temp file. */
const tempFor = (file: string) => `${file}.${process.pid}.${randomHex(4)}.tmp`;

/** Its directory must exist. */
export const writeFileAtomic = async (file: string, data: string, { mode }: WriteOptions = {}) => {
  const tmp = tempFor(file);
  await fsp.writeFile(tmp, data, { mode });
  await fsp.rename(tmp, file);
};

export const writeFileAtomicSync = (file: string, data: string, { mode }: WriteOptions = {}) => {
  const tmp = tempFor(file);
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
};

export const ensureDir = (dir: string, { mode }: WriteOptions = {}) => {
  fs.mkdirSync(dir, { recursive: true, mode });
};

export const ensureDirs = (...dirs: string[]) => {
  for (const dir of dirs) ensureDir(dir);
};

/** `dirMode` applies to directories it creates. */
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
