import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { collection, HttpJsonStore, JsonDirStore, type JsonStore, renamed, type StoreMemory, storeHandler, type Stores } from "../src/store/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tmpDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "utils-store-"));
  dirs.push(dir);
  return dir;
};
const mode = (file: string) => fs.statSync(file).mode & 0o777;

/** A Durable Object's storage, as the Worker gives it to `storeHandler`. */
const memory = () => {
  const values = new Map<string, string>();
  const store: StoreMemory = {
    get: async (key) => values.get(key),
    put: async (key, value) => void values.set(key, value),
    delete: async (key) => values.delete(key),
    list: async (prefix) => [...values.keys()].filter((k) => k.startsWith(prefix)),
  };
  return { values, store };
};

/** A request to a store handler, as the Worker's Outbound passes it on. */
const ask = (handle: (req: Request) => Promise<Response>, method: string, pathAndQuery: string, body?: string) =>
  handle(new Request(new URL(pathAndQuery, "http://store.achq.internal").href, { method, body }));

/** HttpJsonStores served by `handle`, as the router and deployer reach the Worker's store. */
const httpStores =
  (handle: (req: Request) => Promise<Response>): Stores =>
  (name) =>
    new HttpJsonStore(`http://store.achq.internal/${name}`, ((url: string, init: RequestInit) => handle(new Request(url, init))) as typeof fetch);

describe("storeHandler", () => {
  test("lists, reads, writes and removes JSON by collection and name", async () => {
    const { values, store } = memory();
    const handle = storeHandler(store);
    expect((await ask(handle, "PUT", "/inbox?name=d-1", `{"a":1}`)).status).toBe(204);
    await ask(handle, "PUT", "/inbox?name=d-0", `{"a":0}`);
    await ask(handle, "PUT", "/repos?name=acme%2Fw", `{}`);
    expect(await (await ask(handle, "GET", "/inbox")).json()).toEqual(["d-0", "d-1"]);
    expect(await (await ask(handle, "GET", "/inbox?name=d-1")).json()).toEqual({ a: 1 });
    expect(values.has("store/repos/acme/w")).toBe(true);
    await ask(handle, "DELETE", "/inbox?name=d-1");
    expect((await ask(handle, "GET", "/inbox?name=d-1")).status).toBe(404);
    expect((await ask(handle, "GET", "/inbox/a/b")).status).toBe(400);
    expect((await ask(handle, "GET", "/")).status).toBe(400);
    expect((await ask(handle, "GET", "/in%zzbox")).status).toBe(400);
    expect((await ask(handle, "POST", "/inbox")).status).toBe(405);
  });

  test("round-trips any name through HttpJsonStore, and none leaves its collection", async () => {
    const { store } = memory();
    const handle = storeHandler(store);
    const stores = httpStores(handle);
    const odd = ["owner/name", "..", ".", "", "a?b&name=c", "../inbox/d-0", "100%"];
    await stores("inbox").write("d-0", { a: 0 });
    for (const [i, name] of odd.entries()) await stores("odd").write(name, i);
    expect(await stores("odd").list()).toEqual([...odd].sort());
    for (const [i, name] of odd.entries()) expect(await stores("odd").read(name)).toBe(i);
    expect(await stores("odd").all()).toEqual(odd.map((name, i) => [name, i] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, i]) => i));
    expect(await stores("inbox").list()).toEqual(["d-0"]);
    expect(await stores("odd").read("missing")).toBeUndefined();
    await stores("odd").remove("owner/name");
    expect(await stores("odd").read("owner/name")).toBeUndefined();
  });

  test("imports nothing, so a container Worker's build can take it from achq's archive alone", () => {
    const source = fs.readFileSync(path.join(import.meta.dir, "../src/store/handler.ts"), "utf8");
    expect(source).not.toMatch(/^\s*(import|export .* from)\b/m);
  });

  // Delete with the path form in src/store/handler.ts.
  test("also takes a name in the path, as services before names went in the query gave it, under the same key", async () => {
    const handle = storeHandler(memory().store);
    expect((await ask(handle, "PUT", "/repos/acme__w", `{"a":1}`)).status).toBe(204);
    expect(await (await ask(handle, "GET", "/repos/acme__w")).json()).toEqual({ a: 1 });
    expect(await (await ask(handle, "GET", "/repos?name=acme__w")).json()).toEqual({ a: 1 });
    expect(await (await ask(handle, "GET", "/repos")).json()).toEqual(["acme__w"]);
    expect((await ask(handle, "DELETE", "/repos/acme__w")).status).toBe(204);
    expect((await ask(handle, "GET", "/repos/acme__w")).status).toBe(404);
    expect((await ask(handle, "GET", "/repos/a%2Fb")).status).toBe(400);
    expect((await ask(handle, "GET", "/repos/%zz")).status).toBe(400);
  });
});

describe("JsonDirStore", () => {
  test("reads, writes, lists and removes by name", async () => {
    const store = new JsonDirStore(path.join(tmpDir(), "records"));
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
    const store = new JsonDirStore(tmpDir());
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.write("n", i)));
    expect(await store.read("n")).toBe(9);
  });

  test("takes any string as a name, kept in its own file in the directory, and lists it back", async () => {
    const root = tmpDir();
    const dir = path.join(root, "records");
    const store = new JsonDirStore(dir);
    const names = ["owner/name", "../x", ".hidden", "..", ".", "", "100%", "a%2Fb", "ünï"];
    for (const [i, name] of names.entries()) await store.write(name, i);
    expect(await store.list()).toEqual([...names].sort());
    for (const [i, name] of names.entries()) expect(await store.read(name)).toBe(i);
    // Nothing outside the directory, and no file hidden in it but the empty name's, `.json`.
    expect(fs.readdirSync(root)).toEqual(["records"]);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith("."))).toEqual([".json"]);
    expect(fs.existsSync(path.join(dir, "owner%2Fname.json"))).toBe(true);
    await store.remove("owner/name");
    expect(await store.read("owner/name")).toBeUndefined();
  });

  test("lists only names it encoded, so each one listed reads back", async () => {
    const dir = tmpDir();
    for (const file of ["plain.json", "bad%zz.json", "a%2fb.json"]) fs.writeFileSync(path.join(dir, file), "1");
    expect(await new JsonDirStore(dir).list()).toEqual(["plain"]);
  });

  test("writes with the store's mode and format", async () => {
    const dir = tmpDir();
    await new JsonDirStore(dir, { pretty: true, mode: 0o600 }).write("a", { a: 1 });
    expect(fs.readFileSync(path.join(dir, "a.json"), "utf8")).toBe(`{\n  "a": 1\n}\n`);
    expect(mode(path.join(dir, "a.json"))).toBe(0o600);
  });
});

const Repo = z.looseObject({ repo: z.string(), n: z.number() });

describe("collection", () => {
  test("reads and writes values of its schema's type", async () => {
    const dir = tmpDir();
    const stores: Stores = (name) => new JsonDirStore(path.join(dir, name));
    const repos = await collection(stores, "repos", Repo, { log: () => {} });
    await repos.write("a", { repo: "acme/a", n: 1 });
    const read = await repos.read("a");
    const n: number | undefined = read?.n;
    expect(n).toBe(1);
    // @ts-expect-error: not a Repo, so it reads as absent.
    await repos.write("b", { repo: "acme/b" });
    const all: { repo: string }[] = await repos.all();
    expect(all.map((r) => r.repo)).toEqual(["acme/a"]);
  });

  test("treats a value that fails its schema as absent, logging why, and keeps it", async () => {
    const dir = tmpDir();
    const stores: Stores = (name) => new JsonDirStore(path.join(dir, name));
    await stores("repos").write("a", { repo: "acme/a", n: 1 });
    await stores("repos").write("b", { repo: "acme/b", n: "two" });
    const logs: string[] = [];
    const repos = await collection(stores, "repos", Repo, { log: (line) => logs.push(line) });
    expect(await repos.read("b")).toBeUndefined();
    expect(await repos.all()).toEqual([{ repo: "acme/a", n: 1 }]);
    expect(await repos.list()).toEqual(["a", "b"]);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toBe(`store: repos "b" isn't readable, so it's treated as absent: n: Invalid input: expected number, received string`);
    // Nothing removed it: a newer version can still read it, and the next write replaces it.
    expect(await stores("repos").read("b")).toEqual({ repo: "acme/b", n: "two" });
    await repos.write("b", { repo: "acme/b", n: 2 });
    expect(await repos.read("b")).toEqual({ repo: "acme/b", n: 2 });
  });

  test("keeps the keys its schema doesn't know, as a newer version wrote them", async () => {
    const dir = tmpDir();
    const stores: Stores = (name) => new JsonDirStore(path.join(dir, name));
    await stores("repos").write("a", { repo: "acme/a", n: 1, newer: true });
    expect(await (await collection(stores, "repos", Repo)).read("a")).toEqual({ repo: "acme/a", n: 1, newer: true });
  });

  test("runs its migrations, in order, before it returns", async () => {
    const dir = tmpDir();
    const stores: Stores = (name) => new JsonDirStore(path.join(dir, name));
    await stores("repos").write("acme__a", { repo: "acme/a", n: 1 });
    await stores("repos").write("acme/b", { repo: "acme/b", n: 2 });
    await stores("repos").write("bad", { repo: 3 });
    const seen: string[][] = [];
    const listed = (raw: JsonStore) => raw.list().then((names) => void seen.push(names));
    const repos = await collection(stores, "repos", Repo, { log: () => {}, migrate: [listed, renamed((_name, value) => value.repo), listed] });
    expect(seen).toEqual([
      ["acme/b", "acme__a", "bad"],
      ["acme/a", "acme/b", "bad"],
    ]);
    // Moved as it was written; one its schema can't read stays where it is.
    expect(await repos.read("acme/a")).toEqual({ repo: "acme/a", n: 1 });
    expect(await stores("repos").read("bad")).toEqual({ repo: 3 });
    // Run again, it has nothing left to move.
    await collection(stores, "repos", Repo, { log: () => {}, migrate: [renamed((_name, value) => value.repo)] });
    expect(await repos.list()).toEqual(["acme/a", "acme/b", "bad"]);
  });
});
