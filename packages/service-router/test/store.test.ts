import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Stores } from "@achq/core";
import { HttpJsonStore } from "@achq/utils/http";
import { accepted, boot, comment, deliveryIds, deployed, hold, repo } from "./harness.ts";

/** A JSON store over HTTP, as Cloudflare's container provider serves one from a Durable Object: by collection, then name. */
const startStore = () => {
  const values = new Map<string, string>();
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      if (req.method === "PUT") values.set(path, await req.text());
      else if (req.method === "DELETE") values.delete(path);
      else if (values.has(path)) return new Response(values.get(path));
      else if (req.method === "GET" && path.split("/").length === 2) {
        const names = [...values.keys()].filter((k) => k.startsWith(`${path}/`)).map((k) => k.slice(path.length + 1));
        return Response.json(names.sort());
      } else return new Response("not found", { status: 404 });
      return new Response(null, { status: 204 });
    },
  });
  return { url: server.url.href.replace(/\/$/, ""), values, stop: () => server.stop(true) };
};

let store: ReturnType<typeof startStore>;
afterEach(() => store?.stop());

/** The container provider's store, there. */
const httpStores =
  (url: string): Stores =>
  (collection) =>
    new HttpJsonStore(`${url}/${collection}`);

test("the router keeps its inbox, config and claims in its container provider's store, whatever keeps it", async () => {
  store = startStore();
  const r = await deployed({ stores: httpStores(store.url) });
  const gate = hold(r.dev);
  const event = comment(40);
  expect((await r.webhook(event)).status).toBe(202);
  // In the store before the router answered, and nothing on disk.
  expect(JSON.parse(store.values.get(`/inbox/${event.delivery}`)!).event.delivery).toBe(event.delivery!);
  expect(store.values.has(`/repos/${repo.replace("/", "__")}`)).toBe(true);
  expect(existsSync(join(r.dir, "inbox"))).toBe(false);

  await gate.reached;
  // A router started afresh on another disk, with the same store, has the config and replays the inbox.
  r.dev.respond = accepted;
  const second = await boot({ stores: httpStores(store.url) });
  await second.router.settled();
  expect(deliveryIds(r.dev)).toEqual([event.delivery!, event.delivery!]);
  expect(store.values.has(`/inbox/${event.delivery}`)).toBe(false);
  gate.release();
  await r.router.settled();
});
