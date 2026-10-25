import * as fsp from "node:fs/promises";
import { async } from "../async.ts";
import { disk, type JsonWriteOptions } from "../disk.ts";
import { allOf, type JsonStore } from "./json-store.ts";

/**
 * A name as a file name, reversibly: percent-encoded, so `/` and the like
 * can't make it a path, with a leading `.` escaped too, so it's never hidden
 * (but for the empty name's, `.json`).
 * `%2E` is never `encodeURIComponent`'s, so decoding gives the name back.
 */
const encodeName = (name: string) => encodeURIComponent(name).replace(/^\./, "%2E");

/** The name a file name was encoded from, or undefined for one `encodeName` didn't make. */
const decodeName = (file: string) => {
  try {
    const name = decodeURIComponent(file);
    return encodeName(name) === file ? name : undefined;
  } catch {
    return undefined;
  }
};

/** JSON files in `dir`, one per name, created on the first write. Any string is a name: each is encoded as a file name, and decoded back by `list`. */
export class JsonDirStore implements JsonStore {
  /** One write or removal of a name at a time, in the order asked for. */
  private inOrder = async.keyedQueue();

  constructor(
    readonly dir: string,
    private options: JsonWriteOptions = {},
  ) {}

  private fileOf(name: string) {
    return disk.jsonFile(this.dir, encodeName(name));
  }

  read(name: string) {
    return disk.readJson<unknown>(this.fileOf(name));
  }

  async write(name: string, value: unknown) {
    const file = this.fileOf(name);
    await this.inOrder(name, () => disk.writeJson(file, value, this.options));
  }

  /** Removing a missing name is fine. */
  async remove(name: string) {
    const file = this.fileOf(name);
    await this.inOrder(name, () => fsp.rm(file, { force: true }));
  }

  /** Every stored name, sorted. Files it didn't write are skipped. */
  async list() {
    return (await disk.listJsonNames(this.dir))
      .map(decodeName)
      .filter((name) => name !== undefined)
      .sort();
  }

  /** Every stored value, in name order. */
  all() {
    return allOf(this);
  }
}
