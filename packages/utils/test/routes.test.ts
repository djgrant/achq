import { describe, expect, expectTypeOf, test } from "bun:test";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { HttpError } from "../src/http.ts";
import { handler, route, routeClient, type RouteFetcher, type RouteRequest, service } from "../src/routes.ts";

const Thing = z.looseObject({ id: z.string(), size: z.number() });

const getThing = createRoute({
  method: "get",
  path: "/things/{owner}/{id}",
  request: { params: z.object({ owner: z.string(), id: z.string() }), query: z.object({ deep: z.enum(["yes", "no"]).optional() }) },
  responses: { 200: route.json(Thing), 404: route.text("no such thing") },
});
const putThing = createRoute({
  method: "put",
  path: "/things/{id}",
  request: { params: z.object({ id: z.string() }), body: route.body(Thing) },
  responses: { 204: route.empty("stored"), 400: route.text("bad thing") },
});
const ping = createRoute({ method: "get", path: "/ping", responses: { 200: route.text("pong") } });
const routes = { getThing, putThing, ping };

/** A fetcher that records what it's sent and answers with `answer`. */
const recording = (answer: (path: string, init: RouteRequest) => Response) => {
  const sent: { path: string; init: RouteRequest }[] = [];
  const fetcher: RouteFetcher = async (path, init) => {
    sent.push({ path, init });
    return answer(path, init);
  };
  return { sent, fetcher };
};

describe("routeClient", () => {
  test("fills and encodes params, adds the query, sends the body as JSON, and parses the answer with its schema", async () => {
    const { sent, fetcher } = recording((path) => (path.startsWith("/things/") && !path.includes("?") ? new Response(null, { status: 204 }) : path === "/ping" ? new Response("pong") : Response.json({ id: "a b", size: 2, extra: true })));
    const client = routeClient(routes, fetcher, { service: "Things" });
    expect(await client.getThing({ params: { owner: "o/x", id: "a b" }, query: { deep: "yes" } })).toEqual({ id: "a b", size: 2, extra: true });
    expect(sent[0]).toEqual({ path: "/things/o%2Fx/a%20b?deep=yes", init: { method: "GET", body: undefined, headers: undefined } });
    expect(await client.putThing({ params: { id: "t" }, body: { id: "t", size: 1 } })).toBeUndefined();
    expect(sent[1]).toEqual({ path: "/things/t", init: { method: "PUT", body: '{"id":"t","size":1}', headers: { "content-type": "application/json" } } });
    expect(await client.ping()).toBe("pong");
  });

  test("a refusal throws an HttpError with its status and body, naming the service", async () => {
    const client = routeClient(routes, recording(() => new Response("no such thing", { status: 404 })).fetcher, { service: "Things" });
    const error = await client.getThing({ params: { owner: "o", id: "x" } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 404, body: "no such thing", service: "Things", message: "Things GET /things/o/x: 404 no such thing" });
    // A status the route doesn't declare is refused all the same.
    await expect(routeClient(routes, recording(() => new Response("down", { status: 503 })).fetcher).ping()).rejects.toMatchObject({ status: 503, body: "down" });
  });

  test("an answer that isn't the route's is an error, but not an HttpError: its status says nothing", async () => {
    const answering = (res: () => Response) => routeClient(routes, recording(res).fetcher, { service: "Things" });
    const wrong = await answering(() => Response.json({ id: 1 })).getThing({ params: { owner: "o", id: "x" } }).catch((e: unknown) => e);
    expect(wrong).not.toBeInstanceOf(HttpError);
    expect((wrong as Error).message).toBe("Things GET /things/o/x: 200 isn't what the route declares: id: Invalid input: expected string, received number");
    await expect(answering(() => new Response("<html>")).getThing({ params: { owner: "o", id: "x" } })).rejects.toThrow("200 isn't what the route declares: not JSON: <html>");
    await expect(answering(() => Response.json({ id: "x", size: 1 }, { status: 201 })).getThing({ params: { owner: "o", id: "x" } })).rejects.toThrow(
      "Things GET /things/o/x: 201, which the route doesn't declare",
    );
  });

  test("a request that fails its schema isn't sent", async () => {
    const { sent, fetcher } = recording(() => new Response(null, { status: 204 }));
    const client = routeClient(routes, fetcher);
    await expect(client.putThing({ params: { id: "t" }, body: { id: "t", size: "big" as never } })).rejects.toThrow();
    await expect(client.getThing({ params: { owner: "o", id: "x" }, query: { deep: "maybe" as never } })).rejects.toThrow();
    expect(sent).toEqual([]);
  });

  test("its arguments and results are the routes' declared types", () => {
    const client = routeClient(routes, recording(() => new Response()).fetcher);
    // Checked by tsc only: bun's runtime expectTypeOf doesn't implement `parameter` and `returns`.
    const types = () => {
      expectTypeOf(client.ping).toEqualTypeOf<() => Promise<string>>();
      expectTypeOf(client.putThing).parameter(0).toEqualTypeOf<{ params: { id: string }; body: { [k: string]: unknown; id: string; size: number } }>();
      expectTypeOf(client.putThing).returns.resolves.toEqualTypeOf<void>();
      expectTypeOf(client.getThing).parameter(0).toEqualTypeOf<{ params: { owner: string; id: string } } & { query?: { deep?: "yes" | "no" } }>();
      expectTypeOf(client.getThing).returns.resolves.toEqualTypeOf<{ [k: string]: unknown; id: string; size: number }>();
    };
    const wrong = () => {
      // @ts-expect-error A missing path param.
      void client.getThing({ params: { owner: "o" } });
      // @ts-expect-error A missing body.
      void client.putThing({ params: { id: "t" } });
      // @ts-expect-error A body that isn't the route's.
      void client.putThing({ params: { id: "t" }, body: { id: 1, size: 1 } });
      // @ts-expect-error A route that takes nothing.
      void client.ping({});
      // @ts-expect-error A route that isn't declared.
      void client.pong();
    };
    expect(types).toBeFunction();
    expect(wrong).toBeFunction();
  });
});

describe("handlers are checked against their route's responses", () => {
  test("a handler that answers what the route doesn't declare is a type error", () => {
    const app = new OpenAPIHono();
    app.openapi(getThing, (c) => (c.req.valid("param").id ? c.json({ id: "x", size: 1 }, 200) : c.text("no such thing", 404)));
    // @ts-expect-error A field the schema doesn't have, in place of one it requires.
    app.openapi(getThing, (c) => c.json({ id: "x", sise: 1 }, 200));
    // @ts-expect-error The right body, at a status the route doesn't declare.
    app.openapi(getThing, (c) => c.json({ id: "x", size: 1 }, 201));
    // @ts-expect-error JSON where the route declares text.
    app.openapi(getThing, (c) => c.json({ error: "no such thing" }, 404));

    // The hole: a route declaring a response without content lets its handler answer any Response.
    app.openapi(putThing, (c) => c.json({ anything: true }, 500));
    // `handler` closes it.
    app.openapi(
      putThing,
      handler(putThing, (c) => (c.req.valid("json").size ? c.body(null, 204) : c.text("bad thing", 400))),
    );
    // @ts-expect-error A status the route doesn't declare.
    app.openapi(putThing, handler(putThing, (c) => c.body(null, 200)));
    // @ts-expect-error JSON where the route declares text.
    app.openapi(putThing, handler(putThing, (c) => c.json({ error: "bad thing" }, 400)));
    // @ts-expect-error An untyped Response.
    app.openapi(putThing, handler(putThing, () => new Response(null, { status: 204 })));
    expect(app).toBeDefined();
  });

  test("a client and a server built from the same declarations agree", async () => {
    const app = new OpenAPIHono();
    const stored = new Map<string, unknown>();
    app.openapi(
      putThing,
      handler(putThing, (c) => {
        stored.set(c.req.valid("param").id, c.req.valid("json"));
        return c.body(null, 204);
      }),
    );
    app.openapi(getThing, (c) => {
      const thing = Thing.safeParse(stored.get(c.req.valid("param").id));
      return thing.success ? c.json(thing.data, 200) : c.text("no such thing", 404);
    });
    const client = routeClient(routes, async (path, init) => app.request(path, init));
    await client.putThing({ params: { id: "t" }, body: { id: "t", size: 3 } });
    expect(await client.getThing({ params: { owner: "o", id: "t" } })).toEqual({ id: "t", size: 3 });
    // The server validates too: a param or body the route's schema refuses is a 400 from its validator.
    expect((await app.request("/things/t", { method: "PUT", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(400);
    expect((await app.request("/things/t", { method: "PUT" })).status).toBe(400);
  });
});

describe("service", () => {
  const logged: string[] = [];
  const app = service((line) => logged.push(line))
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
