import { expect, test } from "bun:test";
import { HttpJsonStore } from "@achq/utils/http";
import { inbound, outbound, storeRequest, workerUrl } from "../src/routes.ts";
import type { WorkerSettings } from "../src/settings.ts";

const router: WorkerSettings = { name: "achq-router", port: 8080, publicPort: 8080, sleeps: false, restartOnChange: true, image: "cloudflare/debian-trixie", instance: "standard-1", workersDev: "acme.workers.dev" };
const deployer: WorkerSettings = { ...router, name: "achq-deployer", port: 3000, publicPort: undefined };
const isKey = (key: string) => key === "k";

test("the public reaches only a public port; achq's Workers reach any port with the internal key", () => {
  expect(inbound(new Headers(), router, isKey)).toEqual({ port: 8080 });
  // A public request can't pick its port.
  expect(inbound(new Headers({ "x-achq-port": "8081" }), router, isKey)).toEqual({ port: 8080 });
  expect(inbound(new Headers(), deployer, isKey)).toEqual({ refuse: 404 });
  expect(inbound(new Headers({ "x-achq-internal-key": "k", "x-achq-port": "8081" }), router, isKey)).toEqual({ port: 8081 });
  expect(inbound(new Headers({ "x-achq-internal-key": "wrong", "x-achq-port": "8081" }), deployer, isKey)).toEqual({ refuse: 401 });
  expect(inbound(new Headers({ "x-achq-internal-key": "k" }), deployer, isKey)).toEqual({ refuse: 400 });
});

test("a container's requests to achq.internal go to its own Worker's store, keep-awake and archive, or to another Worker's port", () => {
  expect(outbound("store.achq.internal")).toEqual({ to: "store" });
  expect(outbound("awake.achq.internal")).toEqual({ to: "awake" });
  expect(outbound("archive.achq.internal")).toEqual({ to: "archive" });
  expect(outbound("8081.achq-router.achq.internal")).toEqual({ to: "worker", worker: "achq-router", port: 8081 });
  expect(outbound("achq-router.achq.internal")).toEqual({ to: "unknown" });
  expect(workerUrl("achq-router", router, "/credentials?x=1")).toBe("https://achq-router.acme.workers.dev/credentials?x=1");
});

test("the store lists, reads, writes and removes JSON by collection and name", async () => {
  const values = new Map<string, string>();
  const memory = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: string) => void values.set(key, value),
    delete: async (key: string) => values.delete(key),
    list: async (prefix: string) => [...values.keys()].filter((k) => k.startsWith(prefix)),
  };
  expect((await storeRequest("PUT", "/inbox?name=d-1", `{"a":1}`, memory)).status).toBe(204);
  await storeRequest("PUT", "/inbox?name=d-0", `{"a":0}`, memory);
  await storeRequest("PUT", "/repos?name=acme%2Fw", `{}`, memory);
  expect(await (await storeRequest("GET", "/inbox", "", memory)).json()).toEqual(["d-0", "d-1"]);
  expect(await (await storeRequest("GET", "/inbox?name=d-1", "", memory)).json()).toEqual({ a: 1 });
  expect(values.has("store/repos/acme/w")).toBe(true);
  await storeRequest("DELETE", "/inbox?name=d-1", "", memory);
  expect((await storeRequest("GET", "/inbox?name=d-1", "", memory)).status).toBe(404);
  expect((await storeRequest("GET", "/inbox/a/b", "", memory)).status).toBe(400);
  expect((await storeRequest("GET", "/", "", memory)).status).toBe(400);
  expect((await storeRequest("GET", "/in%zzbox", "", memory)).status).toBe(400);

  // Through HttpJsonStore, as the router and deployer reach it: any name round-trips, and none leaves its collection.
  const store = (collection: string) =>
    new HttpJsonStore<number>(`http://store.achq.internal/${collection}`, (async (url: string, init: RequestInit) => {
      const { pathname, search } = new URL(url);
      return storeRequest(init.method!, pathname + search, (init.body as string | undefined) ?? "", memory);
    }) as typeof fetch);
  const odd = ["owner/name", "..", ".", "", "a?b&name=c", "../inbox/d-0", "100%"];
  for (const [i, name] of odd.entries()) await store("odd").write(name, i);
  expect(await store("odd").list()).toEqual([...odd].sort());
  for (const [i, name] of odd.entries()) expect(await store("odd").read(name)).toBe(i);
  expect(await (await storeRequest("GET", "/inbox", "", memory)).json()).toEqual(["d-0"]);
});

// Delete with the path form in src/routes.ts.
test("the store also takes a name in the path, as services before names went in the query gave it, under the same key", async () => {
  const values = new Map<string, string>();
  const memory = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: string) => void values.set(key, value),
    delete: async (key: string) => values.delete(key),
    list: async (prefix: string) => [...values.keys()].filter((k) => k.startsWith(prefix)),
  };
  expect((await storeRequest("PUT", "/repos/acme__w", `{"a":1}`, memory)).status).toBe(204);
  expect(await (await storeRequest("GET", "/repos/acme__w", "", memory)).json()).toEqual({ a: 1 });
  expect(await (await storeRequest("GET", "/repos?name=acme__w", "", memory)).json()).toEqual({ a: 1 });
  expect(await (await storeRequest("GET", "/repos", "", memory)).json()).toEqual(["acme__w"]);
  expect((await storeRequest("DELETE", "/repos/acme__w", "", memory)).status).toBe(204);
  expect((await storeRequest("GET", "/repos/acme__w", "", memory)).status).toBe(404);
  expect((await storeRequest("GET", "/repos/a%2Fb", "", memory)).status).toBe(400);
  expect((await storeRequest("GET", "/repos/%zz", "", memory)).status).toBe(400);
});
