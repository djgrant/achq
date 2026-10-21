import { describe, expect, test } from "bun:test";
import { http, HttpError } from "../src/http.ts";

describe("errors for unwanted responses", () => {
  test("HttpError names the http.service, request and status, with the body cut short", () => {
    const body = "x".repeat(1000);
    const error = new HttpError(404, "GET", "/repos/a/b", body, "GitHub");
    expect(error.message).toBe(`GitHub GET /repos/a/b: 404 ${http.excerpt(body)}`);
    expect(http.excerpt(body).length).toBeLessThan(body.length);
    expect(error.body).toBe(body);
    expect(new HttpError(500, "POST", "/x", "").message).toBe("POST /x: 500");
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

describe("service", () => {
  const logged: string[] = [];
  const app = http.service((line) => logged.push(line))
    .get("/hello", (c) => c.text(`hello ${c.req.query("a")}`))
    .post("/boom", () => {
      throw new Error("secret detail");
    });

  test("health, a handled route, and 404 for the rest", async () => {
    expect(await (await app.fetch(new Request("http://x/"))).text()).toBe("ok");
    expect(await (await app.fetch(new Request("http://x/hello?a=1"))).text()).toBe("hello 1");
    expect((await app.fetch(new Request("http://x/nope"))).status).toBe(404);
  });

  test("a throw is logged and answered with a 500 that doesn't leak it", async () => {
    const res = await app.fetch(new Request("http://x/boom", { method: "POST" }));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("internal error");
    expect(logged.at(-1)).toStartWith("POST /boom: Error: secret detail");
  });
});
