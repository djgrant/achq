import { describe, expect, test } from "bun:test";
import { http, HttpError } from "../src/http.ts";

describe("errors for unwanted responses", () => {
  test("HttpError names the service, request and status, with the body cut short", () => {
    const body = "x".repeat(1000);
    const error = new HttpError(404, "GET", "/repos/a/b", body, "GitHub");
    expect(error.message).toBe(`GitHub GET /repos/a/b: 404 ${http.excerpt(body)}`);
    expect(http.excerpt(body).length).toBeLessThan(body.length);
    expect(error.body).toBe(body);
    expect(new HttpError(500, "POST", "/x", "").message).toBe("POST /x: 500");
    expect(http.excerpt('<!DOCTYPE html>\n<html><head><title> Page not found </title></head><body>…</body></html>')).toBe("Page not found");
  });

  test("expectOk passes 2xx through and throws for anything else", async () => {
    const ok = new Response("fine");
    expect(await http.expectOk(ok, "Reading")).toBe(ok);
    await expect(http.expectOk(new Response("nope", { status: 403 }), "The router refused credentials")).rejects.toThrow("The router refused credentials: 403 nope");
    expect((await http.responseError(new Response("", { status: 502 }), "Waking")).message).toBe("Waking: 502");
  });
});

test("bearerToken reads the Authorization header", () => {
  expect(http.bearerToken(new Request("http://x/", { headers: { authorization: "Bearer abc" } }))).toBe("abc");
  expect(http.bearerToken(new Request("http://x/", { headers: { authorization: "token abc" } }))).toBeUndefined();
  expect(http.bearerToken(new Request("http://x/"))).toBeUndefined();
});
