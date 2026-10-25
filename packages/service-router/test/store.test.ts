import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouterRepoConfig, Stores } from "@achq/core";
import { dirStores } from "@achq/test-utils/stores";
import { HttpJsonStore } from "@achq/utils/http";
import { accepted, boot, comment, deliveryIds, deployed, hold, repo } from "./harness.ts";

/** A JSON store over HTTP, as Cloudflare's container provider serves one from a Durable Object: by collection, then name. */
const startStore = () => {
  const values = new Map<string, string>();
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const name = url.searchParams.get("name");
      const key = `${url.pathname}/${name}`;
      if (name === null) {
        const names = [...values.keys()].filter((k) => k.startsWith(`${url.pathname}/`)).map((k) => k.slice(url.pathname.length + 1));
        return Response.json(names.sort());
      }
      if (req.method === "PUT") values.set(key, await req.text());
      else if (req.method === "DELETE") values.delete(key);
      else if (values.has(key)) return new Response(values.get(key));
      else return new Response("not found", { status: 404 });
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
  expect(store.values.has(`/repos/${repo}`)).toBe(true);
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

// Delete with renameStored.
test("a router started on a store with repos under their old file names moves them to their keys, on disk or over HTTP, and routes by them", async () => {
  store = startStore();
  const dir = mkdtempSync(join(tmpdir(), "achq-router-"));
  for (const stores of [dirStores(dir), httpStores(store.url)]) {
    const first = await deployed({ stores });
    // As an older router kept them: config and claims under `owner__name`.
    const config = await stores<RouterRepoConfig>("repos").read(repo);
    await stores("repos").write(repo.replace("/", "__"), config);
    await stores("repos").remove(repo);
    await stores("claims").write(repo.replace("/", "__"), { [`test:${repo}#5`]: { dev: "dev-docs" } });

    const again = await boot({ stores });
    expect(await stores("repos").list()).toEqual([repo]);
    expect(await stores("claims").list()).toEqual([repo]);
    // The claim moved with it: the thread stays in its docs workspace, though its event no longer has the label.
    await again.webhook(comment(5));
    await again.router.settled();
    expect(first.dev.events.at(-1)!.workspace).toBe("dev-docs");
  }
});
