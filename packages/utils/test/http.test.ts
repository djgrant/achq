import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  bearerToken,
  ERROR_BODY_CHARS,
  expectOk,
  HttpError,
  jsonResponse,
  noContent,
  parseBody,
  parseObject,
  responseError,
  textResponse,
  withHealthAndErrors,
} from "../src/http.ts";

describe("errors for unwanted responses", () => {
  test("HttpError names the service, request and status, with the body cut short", () => {
    const error = new HttpError(404, "GET", "/repos/a/b", "x".repeat(ERROR_BODY_CHARS + 10), "GitHub");
    expect(error.message).toBe(`GitHub GET /repos/a/b: 404 ${"x".repeat(ERROR_BODY_CHARS)}`);
    expect(error.body.length).toBe(ERROR_BODY_CHARS + 10);
    expect(new HttpError(500, "POST", "/x", "").message).toBe("POST /x: 500");
  });

  test("expectOk passes 2xx through and throws for anything else", async () => {
    const ok = new Response("fine");
    expect(await expectOk(ok, "Reading")).toBe(ok);
    await expect(expectOk(new Response("nope", { status: 403 }), "The router refused credentials")).rejects.toThrow("The router refused credentials: 403 nope");
    expect((await responseError(new Response("", { status: 502 }), "Waking")).message).toBe("Waking: 502");
  });
});

test("responses", async () => {
  expect(await textResponse("hi", 201).text()).toBe("hi");
  expect(textResponse("hi", 201).status).toBe(201);
  expect(await jsonResponse({ a: 1 }).json()).toEqual({ a: 1 });
  expect(noContent().status).toBe(204);
});

test("bearerToken reads the Authorization header", () => {
  expect(bearerToken(new Request("http://x/", { headers: { authorization: "Bearer abc" } }))).toBe("abc");
  expect(bearerToken(new Request("http://x/", { headers: { authorization: "token abc" } }))).toBeUndefined();
  expect(bearerToken(new Request("http://x/"))).toBeUndefined();
});

describe("request bodies", () => {
  test("parseObject accepts only a JSON object", () => {
    expect(parseObject<{ a: number }>(`{"a":1}`)).toEqual({ a: 1 });
    expect(parseObject("[1]")).toBeUndefined();
    expect(parseObject("null")).toBeUndefined();
    expect(parseObject("{")).toBeUndefined();
  });

  test("parseBody checks against a zod schema", () => {
    const schema = z.object({ repo: z.string(), prune: z.boolean().default(false) });
    expect(parseBody(schema, `{"repo":"a/b"}`)).toEqual({ repo: "a/b", prune: false });
    expect(parseBody(schema, `{"repo":1}`)).toBeUndefined();
    expect(parseBody(schema, "{")).toBeUndefined();
    expect(parseBody(z.object({ dryRun: z.boolean().optional() }), "")).toEqual({});
  });
});

describe("withHealthAndErrors", () => {
  const logged: string[] = [];
  const handler = withHealthAndErrors((req, url) => {
    if (url.pathname === "/boom") throw new Error("secret detail");
    if (url.pathname === "/hello") return textResponse(`hello ${url.search}`);
  }, (line) => logged.push(line));

  test("health, a handled route, and 404 for the rest", async () => {
    expect(await (await handler(new Request("http://x/"))).text()).toBe("ok");
    expect(await (await handler(new Request("http://x/hello?a=1"))).text()).toBe("hello ?a=1");
    expect((await handler(new Request("http://x/nope"))).status).toBe(404);
  });

  test("a throw is logged and answered with a 500 that doesn't leak it", async () => {
    const res = await handler(new Request("http://x/boom", { method: "POST" }));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("internal error");
    expect(logged.at(-1)).toStartWith("POST /boom: Error: secret detail");
  });
});
