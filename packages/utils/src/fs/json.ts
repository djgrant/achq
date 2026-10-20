// JSON files as state: a missing file reads as a fallback rather than an
// error, and writes are atomic (see write.ts) into a directory made on demand.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { isNotFound, writeFileAtomic, writeFileAtomicSync } from "./write.ts";

const JSON_EXT = ".json";

/** `pretty` indents by two spaces and ends with a newline, for files people read. */
export type JsonWriteOptions = { pretty?: boolean; mode?: number };

const serialise = (value: unknown, pretty?: boolean) => (pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value));

/** The parsed file, or `fallback` if it doesn't exist. */
export async function readJson<T>(file: string): Promise<T | undefined>;
export async function readJson<T>(file: string, fallback: T): Promise<T>;
export async function readJson<T>(file: string, fallback?: T): Promise<T | undefined> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8")) as T;
  } catch (e) {
    if (isNotFound(e)) return fallback;
    throw e;
  }
}

export function readJsonSync<T>(file: string): T | undefined;
export function readJsonSync<T>(file: string, fallback: T): T;
export function readJsonSync<T>(file: string, fallback?: T): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (e) {
    if (isNotFound(e)) return fallback;
    throw e;
  }
}

export const writeJson = async (file: string, value: unknown, { pretty, mode }: JsonWriteOptions = {}) => {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, serialise(value, pretty), { mode });
};

export const writeJsonSync = (file: string, value: unknown, { pretty, mode }: JsonWriteOptions = {}) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomicSync(file, serialise(value, pretty), { mode });
};

/** Reads the file (or `fallback`), lets `fn` change it in place or return a replacement, and writes it back. */
export const updateJsonSync = <T>(file: string, fallback: T, fn: (value: T) => T | void, options: JsonWriteOptions = {}): T => {
  const current = readJsonSync(file, fallback);
  const updated = fn(current) ?? current;
  writeJsonSync(file, updated, options);
  return updated;
};

const namesOf = (entries: string[]) =>
  entries
    .filter((f) => f.endsWith(JSON_EXT))
    .map((f) => f.slice(0, -JSON_EXT.length))
    .sort();

/** The `.json` files in `dir`, by name without the extension, sorted. Temp files a crash left are skipped. None if `dir` is missing. */
export const listJsonNames = async (dir: string): Promise<string[]> => {
  try {
    return namesOf(await fsp.readdir(dir));
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
};

export const listJsonNamesSync = (dir: string): string[] => {
  try {
    return namesOf(fs.readdirSync(dir));
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
};

export const jsonFile = (dir: string, name: string) => path.join(dir, `${name}${JSON_EXT}`);
