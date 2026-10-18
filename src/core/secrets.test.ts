import { describe, expect, test } from "bun:test";
import { adminSecret, appWebhookSecret, containerSecret, signedHeaders, verifyGitHubSignature, verifySigned, hmacHex } from "./secrets.ts";

describe("derived secrets", () => {
  test("differ by purpose, App, repo and container, and don't depend on repo case", () => {
    const all = [
      adminSecret("k"),
      appWebhookSecret("k", 1),
      appWebhookSecret("k", 2),
      containerSecret("k", "o/r", "dev"),
      containerSecret("k", "o/r", "ops"),
      containerSecret("k", "o/s", "dev"),
      containerSecret("other", "o/r", "dev"),
    ];
    expect(new Set(all).size).toBe(all.length);
    expect(containerSecret("k", "O/R", "dev")).toBe(containerSecret("k", "o/r", "dev"));
  });
});

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

test("GitHub signatures", () => {
  const s = appWebhookSecret("k", 42);
  const body = '{"action":"created"}';
  expect(verifyGitHubSignature(s, body, `sha256=${hmacHex(s, body)}`)).toBe(true);
  expect(verifyGitHubSignature(s, body, `sha256=${hmacHex(appWebhookSecret("k", 43), body)}`)).toBe(false);
  expect(verifyGitHubSignature(s, body, hmacHex(s, body))).toBe(false);
  expect(verifyGitHubSignature(s, body, null)).toBe(false);
});
