import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminSecret } from "../src/wire/secrets.ts";
import { signedBy, signedFetcher, signedHeaders, signedRequestInit, verifySigned } from "../src/wire/signing.ts";

describe("signed requests", () => {
  const secret = adminSecret("k");
  const at = 1_000_000_000_000;
  const headers = (h: Record<string, string>) => new Headers(h);

  test("accept the request they signed", () => {
    expect(verifySigned(secret, "PUT", "/admin/repos/o/r", "{}", headers(signedHeaders(secret, "put", "/admin/repos/o/r", "{}", at)), at)).toBe(true);
  });

  test("reject a changed body, path, method, secret, or an old timestamp", () => {
    const h = headers(signedHeaders(secret, "PUT", "/admin/repos/o/r", "{}", at));
    expect(verifySigned(secret, "PUT", "/admin/repos/o/r", '{"a":1}', h, at)).toBe(false);
    expect(verifySigned(secret, "PUT", "/admin/repos/o/x", "{}", h, at)).toBe(false);
    expect(verifySigned(secret, "DELETE", "/admin/repos/o/r", "{}", h, at)).toBe(false);
    expect(verifySigned(adminSecret("other"), "PUT", "/admin/repos/o/r", "{}", h, at)).toBe(false);
    expect(verifySigned(secret, "PUT", "/admin/repos/o/r", "{}", h, at + 6 * 60_000)).toBe(false);
    expect(verifySigned(secret, "PUT", "/admin/repos/o/r", "{}", new Headers(), at)).toBe(false);
  });

  test("a re-stamped timestamp without re-signing fails", () => {
    const h = signedHeaders(secret, "POST", "/sync", "", at);
    const later = at + 10 * 60_000;
    expect(verifySigned(secret, "POST", "/sync", "", headers({ ...h, "x-achq-timestamp": String(later) }), later)).toBe(false);
  });
});

describe("signedBy", () => {
  const secret = adminSecret("k");
  const at = 1_000_000_000_000;
  const url = "http://deployer.internal/sync?prune=1";
  const app = new Hono().use(signedBy(secret, () => at)).post("/sync", async (c) => c.text(await c.req.text()));
  const send = (init: RequestInit) => app.fetch(new Request(url, init));

  test("lets through a request signedRequestInit made, over its path and query, with its body", async () => {
    const init = signedRequestInit(secret, "POST", url, `{"a":1}`, { now: at });
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    const res = await send(init);
    expect([res.status, await res.text()]).toEqual([200, `{"a":1}`]);
    expect((await send(signedRequestInit(secret, "POST", url, undefined, { now: at }))).status).toBe(200);
  });

  test("answers 401 to one signed for another query, secret or time", async () => {
    expect((await send(signedRequestInit(secret, "POST", "http://deployer.internal/sync", "{}", { now: at }))).status).toBe(401);
    expect((await send(signedRequestInit(adminSecret("other"), "POST", url, "{}", { now: at }))).status).toBe(401);
    expect((await send(signedRequestInit(secret, "POST", url, "{}", { now: at - 6 * 60_000 }))).status).toBe(401);
  });

  test("passes the signal through", () => {
    const signal = AbortSignal.timeout(1000);
    expect(signedRequestInit(secret, "GET", url, undefined, { signal }).signal).toBe(signal);
  });
});

describe("signedFetcher", () => {
  const secret = adminSecret("k");
  let clock = 1_000_000_000_000;
  const app = new Hono().use(signedBy(secret, () => clock)).post("/admin/sync", async (c) => c.text(await c.req.text()));
  const fetcher = signedFetcher(secret, "http://router.internal/admin/", { fetch: async (url, init) => app.fetch(new Request(url, init)), now: () => clock });

  test("sends to its base, signed over the whole path", async () => {
    const res = await fetcher("/sync", { method: "POST", body: "{}" });
    expect([res.status, await res.text()]).toEqual([200, "{}"]);
  });

  test("signs each call as it's made, so a retry long after the first is still in the window", async () => {
    const attempt = () => fetcher("/sync", { method: "POST", body: "{}" });
    expect((await attempt()).status).toBe(200);
    clock += 10 * 60_000;
    expect((await attempt()).status).toBe(200);
  });
});
