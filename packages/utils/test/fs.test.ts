import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createExclusive,
  createJsonDirStore,
  ensureDirs,
  isNotFound,
  isSafeFileName,
  isWithin,
  listJsonNames,
  listJsonNamesSync,
  readJson,
  readJsonSync,
  readTree,
  resolveWithin,
  safeFileName,
  updateJsonSync,
  writeFileAtomic,
  writeFileAtomicSync,
  writeFileEnsured,
  writeJson,
  writeJsonSync,
} from "../src/fs/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tmpDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "utils-fs-"));
  dirs.push(dir);
  return dir;
};
const mode = (file: string) => fs.statSync(file).mode & 0o777;

describe("atomic writes", () => {
  test("replace the file whole and leave no temp file", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "a.txt");
    await writeFileAtomic(file, "one", { mode: 0o600 });
    writeFileAtomicSync(file, "two");
    expect(fs.readFileSync(file, "utf8")).toBe("two");
    expect(fs.readdirSync(dir)).toEqual(["a.txt"]);
    await writeFileAtomic(path.join(dir, "b"), "x", { mode: 0o600 });
    expect(mode(path.join(dir, "b"))).toBe(0o600);
  });

  test("concurrent writes don't share a temp file", async () => {
    const file = path.join(tmpDir(), "a.txt");
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeFileAtomic(file, String(i))));
    expect(Number(fs.readFileSync(file, "utf8"))).toBeLessThan(20);
  });
});

test("writeFileEnsured creates the directory with its own mode", () => {
  const file = path.join(tmpDir(), "a", "b", "secret");
  writeFileEnsured(file, "s", { mode: 0o600, dirMode: 0o700 });
  expect(fs.readFileSync(file, "utf8")).toBe("s");
  expect(mode(file)).toBe(0o600);
  expect(mode(path.dirname(file))).toBe(0o700);
});

test("ensureDirs creates each", () => {
  const dir = tmpDir();
  ensureDirs(path.join(dir, "a", "b"), path.join(dir, "c"));
  expect(fs.existsSync(path.join(dir, "a", "b")) && fs.existsSync(path.join(dir, "c"))).toBe(true);
});

test("createExclusive is true once", () => {
  const file = path.join(tmpDir(), "delivery");
  expect(createExclusive(file)).toBe(true);
  expect(createExclusive(file)).toBe(false);
  expect(() => createExclusive(path.join(file, "missing", "x"))).toThrow();
});

test("isNotFound recognises ENOENT", () => {
  expect(isNotFound(Object.assign(new Error(), { code: "ENOENT" }))).toBe(true);
  expect(isNotFound(new Error())).toBe(false);
  expect(isNotFound(undefined)).toBe(false);
});

describe("JSON files", () => {
  test("a missing file reads as the fallback", async () => {
    const file = path.join(tmpDir(), "missing.json");
    expect(await readJson(file)).toBeUndefined();
    expect(await readJson(file, [])).toEqual([]);
    expect(readJsonSync(file, {})).toEqual({});
  });

  test("written atomically into a new directory, compact or pretty", async () => {
    const dir = tmpDir();
    await writeJson(path.join(dir, "x", "a.json"), { a: 1 });
    writeJsonSync(path.join(dir, "y", "b.json"), { b: 1 }, { pretty: true });
    expect(fs.readFileSync(path.join(dir, "x", "a.json"), "utf8")).toBe(`{"a":1}`);
    expect(fs.readFileSync(path.join(dir, "y", "b.json"), "utf8")).toBe(`{\n  "b": 1\n}\n`);
    expect(await readJson(path.join(dir, "x", "a.json"))).toEqual({ a: 1 });
  });

  test("a corrupt file throws rather than reading as the fallback", () => {
    const file = path.join(tmpDir(), "bad.json");
    fs.writeFileSync(file, "{");
    expect(() => readJsonSync(file, {})).toThrow();
  });

  test("updateJsonSync changes in place or replaces", () => {
    const file = path.join(tmpDir(), "c.json");
    updateJsonSync<{ n?: number }>(file, {}, (c) => {
      c.n = 1;
    });
    expect(updateJsonSync<{ n?: number }>(file, {}, (c) => ({ n: c.n! + 1 }))).toEqual({ n: 2 });
    expect(readJsonSync(file)).toEqual({ n: 2 });
  });

  test("listJsonNames skips temp files and a missing directory", async () => {
    const dir = tmpDir();
    for (const f of ["b.json", "a.json", "a.json.123.abc.tmp", "notes.txt"]) fs.writeFileSync(path.join(dir, f), "{}");
    expect(await listJsonNames(dir)).toEqual(["a", "b"]);
    expect(listJsonNamesSync(dir)).toEqual(["a", "b"]);
    expect(await listJsonNames(path.join(dir, "missing"))).toEqual([]);
  });
});

describe("createJsonDirStore", () => {
  test("reads, writes, lists and removes by name", async () => {
    const store = createJsonDirStore<{ n: number }>(path.join(tmpDir(), "records"));
    expect(await store.list()).toEqual([]);
    expect(await store.read("a")).toBeUndefined();
    await store.write("b", { n: 2 });
    await store.write("a", { n: 1 });
    expect(await store.read("a")).toEqual({ n: 1 });
    expect(await store.list()).toEqual(["a", "b"]);
    expect(await store.all()).toEqual([{ n: 1 }, { n: 2 }]);
    await store.remove("a");
    await store.remove("a");
    expect(await store.list()).toEqual(["b"]);
  });

  test("writes to one name land in the order they were made", async () => {
    const store = createJsonDirStore<number>(tmpDir());
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.write("n", i)));
    expect(await store.read("n")).toBe(9);
  });

  test("refuses unsafe names", () => {
    const store = createJsonDirStore(tmpDir());
    expect(() => store.read("../x")).toThrow("Unsafe file name: ../x");
    expect(() => store.write(".hidden", 1)).toThrow("Unsafe file name");
  });

  test("writes with the store's mode and format", async () => {
    const dir = tmpDir();
    await createJsonDirStore(dir, { pretty: true, mode: 0o600 }).write("a", { a: 1 });
    expect(fs.readFileSync(path.join(dir, "a.json"), "utf8")).toBe(`{\n  "a": 1\n}\n`);
    expect(mode(path.join(dir, "a.json"))).toBe(0o600);
  });
});

describe("paths", () => {
  test("safe file names", () => {
    expect(safeFileName("owner/repo#42")).toBe("owner_repo_42");
    expect(isSafeFileName("owner__repo")).toBe(true);
    expect(isSafeFileName("..")).toBe(false);
    expect(isSafeFileName("a/b")).toBe(false);
  });

  test("resolveWithin refuses paths that leave the root", () => {
    expect(resolveWithin("/root/.achq", "prompts/a.md")).toBe("/root/.achq/prompts/a.md");
    expect(resolveWithin("/root/.achq", ".")).toBe("/root/.achq");
    expect(resolveWithin("/root/.achq", "../secrets")).toBeUndefined();
    expect(resolveWithin("/root/.achq", "/etc/passwd")).toBeUndefined();
    expect(isWithin("/root/a", "/root/ab")).toBe(false);
  });
});

test("readTree reads every file, skipping named directories", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "lib"));
  fs.mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config.ts"), "c");
  fs.writeFileSync(path.join(dir, "lib", "a.ts"), "a");
  fs.writeFileSync(path.join(dir, "node_modules", "x", "i.js"), "i");
  expect(readTree(dir, { skip: ["node_modules"] })).toEqual({ "config.ts": "c", [path.join("lib", "a.ts")]: "a" });
});
