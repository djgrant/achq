// Every write goes to a temp file and is renamed into place, so a crash never
// leaves half a file.
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** File names come from delivery IDs and repo names, so only allow characters that can't escape the directory. */
const SAFE = /^[\w-][\w.-]*$/;
export const safeName = (name: string) => SAFE.test(name);

/** `owner/repo` as a file name. GitHub names are case-insensitive, so lowercase. */
export const repoFile = (repo: string) => repo.toLowerCase().replace("/", "__");

export const createStore = (root: string) => {
  const path = (dir: string, name: string) => {
    if (!safeName(name)) throw new Error(`Unsafe file name: ${name}`);
    return join(root, dir, `${name}.json`);
  };
  // Writes to one file run in order, so an older snapshot can't land after a newer one.
  const queues = new Map<string, Promise<unknown>>();

  const write = (dir: string, name: string, value: unknown) => {
    const file = path(dir, name);
    const data = JSON.stringify(value);
    const run = async () => {
      await mkdir(join(root, dir), { recursive: true });
      const tmp = `${file}.${crypto.randomUUID()}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, file);
    };
    const next = (queues.get(file) ?? Promise.resolve()).then(run, run);
    queues.set(file, next);
    return next;
  };

  const read = async <T>(dir: string, name: string): Promise<T | undefined> => {
    try {
      return JSON.parse(await readFile(path(dir, name), "utf8")) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  };

  /** Names in `dir`, without temp files left by a crash mid-write. */
  const list = async (dir: string) => {
    try {
      return (await readdir(join(root, dir))).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  };

  const remove = (dir: string, name: string) => rm(path(dir, name), { force: true });

  return { write, read, list, remove };
};

export type Store = ReturnType<typeof createStore>;
