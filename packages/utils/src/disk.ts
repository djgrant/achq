import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { async } from "./async.ts";
import { crypto } from "./crypto.ts";

export type WriteOptions = { mode?: number };

/** `pretty` indents by two spaces and ends with a newline, for files people read. */
export type JsonWriteOptions = WriteOptions & { pretty?: boolean };

const JSON_EXT = ".json";

/** Names that are safe as one path segment: no separators, and not `.` or `..`. */
const SAFE_FILE_NAME = /^[\w-][\w.-]*$/;
const UNSAFE_CHAR = /[^A-Za-z0-9._-]/g;

/** Unique per process and write, so concurrent writers never share a temp file. */
const tempFor = (file: string) => `${file}.${process.pid}.${crypto.randomHex(4)}.tmp`;

const serialise = (value: unknown, pretty?: boolean) => (pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value));

/** The `.json` files among `entries`, by name without the extension, sorted. Temp files a crash left are skipped. */
const jsonNames = (entries: string[]) =>
  entries
    .filter((f) => f.endsWith(JSON_EXT))
    .map((f) => f.slice(0, -JSON_EXT.length))
    .sort();

export const disk = {
  isNotFound: (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code === "ENOENT",

  /** Its directory must exist. */
  writeAtomic: async (file: string, data: string, { mode }: WriteOptions = {}) => {
    const tmp = tempFor(file);
    await fsp.writeFile(tmp, data, { mode });
    await fsp.rename(tmp, file);
  },

  writeAtomicSync: (file: string, data: string, { mode }: WriteOptions = {}) => {
    const tmp = tempFor(file);
    fs.writeFileSync(tmp, data, { mode });
    fs.renameSync(tmp, file);
  },

  ensureDir: (dir: string, { mode }: WriteOptions = {}) => {
    fs.mkdirSync(dir, { recursive: true, mode });
  },

  /** `dirMode` applies to directories it creates. */
  writeEnsured: (file: string, data: string, { mode, dirMode }: WriteOptions & { dirMode?: number } = {}) => {
    disk.ensureDir(path.dirname(file), { mode: dirMode });
    fs.writeFileSync(file, data, { mode });
  },

  /** Creates an empty `file`, or returns false if it already exists. Atomic, so of racing callers exactly one gets true. */
  createExclusive: (file: string) => {
    try {
      fs.writeFileSync(file, "", { flag: "wx" });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  },

  /** The parsed file, or undefined if it doesn't exist. */
  readJson: async <T>(file: string) => {
    try {
      return JSON.parse(await fsp.readFile(file, "utf8")) as T;
    } catch (e) {
      if (disk.isNotFound(e)) return undefined;
      throw e;
    }
  },

  readJsonSync: <T>(file: string) => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as T;
    } catch (e) {
      if (disk.isNotFound(e)) return undefined;
      throw e;
    }
  },

  /** Atomic, so a crash mid-write leaves the file as it was. */
  writeJson: async (file: string, value: unknown, { pretty, mode }: JsonWriteOptions = {}) => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await disk.writeAtomic(file, serialise(value, pretty), { mode });
  },

  writeJsonSync: (file: string, value: unknown, { pretty, mode }: JsonWriteOptions = {}) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    disk.writeAtomicSync(file, serialise(value, pretty), { mode });
  },

  /** Reads the file (or `fallback`), lets `fn` change it in place or return a replacement, and writes it back. */
  updateJsonSync: <T>(file: string, fallback: T, fn: (value: T) => T | void, options: JsonWriteOptions = {}): T => {
    const current = disk.readJsonSync<T>(file) ?? fallback;
    const updated = fn(current) ?? current;
    disk.writeJsonSync(file, updated, options);
    return updated;
  },

  /** The `.json` files in `dir`, by name without the extension, sorted. None if `dir` is missing. */
  listJsonNames: async (dir: string) => {
    try {
      return jsonNames(await fsp.readdir(dir));
    } catch (e) {
      if (disk.isNotFound(e)) return [];
      throw e;
    }
  },

  listJsonNamesSync: (dir: string) => {
    try {
      return jsonNames(fs.readdirSync(dir));
    } catch (e) {
      if (disk.isNotFound(e)) return [];
      throw e;
    }
  },

  jsonFile: (dir: string, name: string) => path.join(dir, `${name}${JSON_EXT}`),

  /** What `fn` gives with a new directory of its own under the system's temp directory, named from `prefix`, which is removed once `fn` is done. */
  withTempDir: async <T>(prefix: string, fn: (dir: string) => T | Promise<T>): Promise<T> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    try {
      return await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },

  /** Every file under `dir`, by path relative to it, as text. Directories named in `skip` aren't entered. */
  readTree: (dir: string, { skip = [] }: { skip?: string[] } = {}) => {
    const files: Record<string, string> = {};
    const walk = (sub: string) => {
      for (const entry of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
        const rel = path.join(sub, entry.name);
        if (entry.isDirectory() && !skip.includes(entry.name)) walk(rel);
        if (entry.isFile()) files[rel] = fs.readFileSync(path.join(dir, rel), "utf8");
      }
    };
    walk("");
    return files;
  },

  isSafeFileName: (name: string) => SAFE_FILE_NAME.test(name),

  safeFileName: (name: string) => name.replace(UNSAFE_CHAR, "_"),

  /** Both must be absolute and normalised. */
  isWithin: (root: string, file: string) => file === root || file.startsWith(root + path.sep),

  /** `relative` resolved against `root`, or undefined if it leads outside `root`. */
  resolveWithin: (root: string, relative: string) => {
    const file = path.resolve(root, relative);
    return disk.isWithin(path.resolve(root), file) ? file : undefined;
  },
};

/** JSON files in `dir`, one per name, created on the first write. Names must be safe file names (see `disk.safeFileName`); others throw. */
export class JsonDirStore<T> {
  /** One write or removal of a name at a time, in the order asked for. */
  private inOrder = async.keyedQueue();

  constructor(
    readonly dir: string,
    private options: JsonWriteOptions = {},
  ) {}

  private fileOf(name: string) {
    if (!disk.isSafeFileName(name)) throw new Error(`Unsafe file name: ${name}`);
    return disk.jsonFile(this.dir, name);
  }

  read(name: string) {
    return disk.readJson<T>(this.fileOf(name));
  }

  write(name: string, value: T) {
    const file = this.fileOf(name);
    return this.inOrder(name, () => disk.writeJson(file, value, this.options));
  }

  /** Removing a missing name is fine. */
  remove(name: string) {
    const file = this.fileOf(name);
    return this.inOrder(name, () => fsp.rm(file, { force: true }));
  }

  /** Every stored name, sorted. */
  list() {
    return disk.listJsonNames(this.dir);
  }

  /** Every stored value, in name order. */
  async all() {
    const values = await Promise.all((await this.list()).map((name) => this.read(name)));
    // A name removed while listing reads as undefined.
    return values.filter((v) => v !== undefined) as T[];
  }
}
