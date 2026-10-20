import { describe, expect, test } from "bun:test";
import { adminSecret } from "../src/wire/secrets.ts";
import { signedHeaders, signedRequestInit, verifyAdminRequest, verifySigned, verifySignedRequest } from "../src/wire/signing.ts";

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

describe("signed Requests", () => {
  const key = "k";
  const secret = adminSecret(key);
  const at = 1_000_000_000_000;
  const url = "http://deployer.internal/sync?prune=1";
  const request = (init: RequestInit) => new Request(url, init);

  test("a request made with signedRequestInit verifies, over its path and query, giving its body", async () => {
    const init = signedRequestInit(secret, "POST", url, `{"a":1}`, { now: at });
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(await verifySignedRequest(request(init), secret, at)).toEqual({ body: `{"a":1}` });
    expect(await verifyAdminRequest(request(signedRequestInit(secret, "POST", url, undefined, { now: at })), key, at)).toEqual({ body: "" });
  });

  test("a request for another query, secret or time doesn't", async () => {
    const init = signedRequestInit(secret, "POST", "http://deployer.internal/sync", "{}", { now: at });
    expect(await verifySignedRequest(request(init), secret, at)).toBeUndefined();
    const signed = signedRequestInit(secret, "POST", url, "{}", { now: at });
    expect(await verifyAdminRequest(request(signed), "other", at)).toBeUndefined();
    expect(await verifySignedRequest(request(signed), secret, at + 6 * 60_000)).toBeUndefined();
  });

  test("passes the signal through", () => {
    const signal = AbortSignal.timeout(1000);
    expect(signedRequestInit(secret, "GET", url, undefined, { signal }).signal).toBe(signal);
  });
});
