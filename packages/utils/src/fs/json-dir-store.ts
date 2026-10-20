// A directory of JSON files, one per name: a small store that survives
// restarts. Writes to one name run in order, so an older value can't land
// after a newer one, and each is atomic, so a crash leaves the old value.
import * as fsp from "node:fs/promises";
import { keyedQueue } from "../async.ts";
import { type JsonWriteOptions, jsonFile, listJsonNames, readJson, writeJson } from "./json.ts";
import { isSafeFileName } from "./paths.ts";

export type JsonDirStore<T> = {
  /** The value stored under `name`, or undefined. */
  read(name: string): Promise<T | undefined>;
  write(name: string, value: T): Promise<void>;
  /** Removing a missing name is fine. */
  remove(name: string): Promise<void>;
  /** Every stored name, sorted. */
  list(): Promise<string[]>;
  /** Every stored value, in name order. */
  all(): Promise<T[]>;
};

/** A store in `dir`, created on the first write. Names must be safe file names (see `safeFileName`); others throw. */
export const createJsonDirStore = <T>(dir: string, options: JsonWriteOptions = {}): JsonDirStore<T> => {
  const fileOf = (name: string) => {
    if (!isSafeFileName(name)) throw new Error(`Unsafe file name: ${name}`);
    return jsonFile(dir, name);
  };
  const inOrder = keyedQueue();

  const read = (name: string) => readJson<T>(fileOf(name));
  const list = () => listJsonNames(dir);
  return {
    read,
    list,
    write: (name, value) => {
      const file = fileOf(name);
      return inOrder(name, () => writeJson(file, value, options));
    },
    remove: (name) => {
      const file = fileOf(name);
      return inOrder(name, () => fsp.rm(file, { force: true }));
    },
    all: async () => {
      const values = await Promise.all((await list()).map(read));
      // A name removed while listing reads as undefined.
      return values.filter((v) => v !== undefined) as T[];
    },
  };
};
