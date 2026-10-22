import { afterEach, expect, test } from "bun:test";
import { adminSecret } from "@achq/core/secrets";
import { verifySigned } from "@achq/core/signing";
import { routerRepoIds } from "../src/lib/repo-ids.ts";

const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach((stop) => stop()));

test("a repo's GitHub ids are read with a token the router mints for it", async () => {
  const minted: unknown[] = [];
  const router = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text();
      if (!verifySigned(adminSecret("key"), req.method, new URL(req.url).pathname, body, req.headers)) return new Response("bad signature", { status: 401 });
      minted.push(JSON.parse(body));
      return Response.json([{ provider: "github", value: "ghs_token", expiresAt: "2026-10-22T13:00:00Z", scope: {} }]);
    },
  });
  const github = Bun.serve({
    port: 0,
    fetch: (req) =>
      req.headers.get("authorization") === "Bearer ghs_token" && new URL(req.url).pathname === "/repos/acme/widgets"
        ? Response.json({ id: 22, name: "widgets", owner: { id: 11, login: "acme" } })
        : new Response("not found", { status: 404 }),
  });
  stops.push(() => router.stop(true), () => github.stop(true));
  const ids = routerRepoIds({ routerUrl: router.url.href, key: "key", githubApi: github.url.href.replace(/\/$/, "") });
  expect(await ids("acme/widgets")).toEqual({ provider_type: "github", provider_account_id: "11", provider_account_name: "acme", repo_id: "22", repo_name: "widgets" });
  expect(minted).toEqual([{ repo: "acme/widgets", policies: [{ provider: "github", repo: "acme/widgets", permissions: { metadata: "read" } }] }]);
  await expect(ids("acme/gone")).rejects.toThrow("GitHub couldn't show acme/gone: 404");
});
