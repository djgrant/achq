// Routes, each declared once with Standard Schema schemas: served on Hono, which checks a request with
// @hono/standard-validator, and called with a typed client, which checks what it sends and reads.
import { sValidator } from "@hono/standard-validator";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { type Context, type Env, Hono, type MiddlewareHandler, type TypedResponse } from "hono";
import type { StatusCode, SuccessStatusCode } from "hono/utils/http-status";
import type { JSONParsed } from "hono/utils/types";
import { errors } from "./errors.ts";
import { http, HttpError } from "./http.ts";
import { schema as schemas } from "./schema.ts";

/** An app that answers health on `GET /`, 404s what it doesn't route, and 500s an error, logging it without leaking it. */
export const service = (log: (line: string) => void) =>
  new Hono()
    .get("/", (c) => c.text("ok"))
    .notFound((c) => c.text("not found", 404))
    .onError((error, c) => {
      log(`${c.req.method} ${c.req.path}: ${errors.detail(error)}`);
      return c.text("internal error", 500);
    });

type Schema = StandardSchemaV1;

/** What a route answers with one status: JSON its schema reads, text, or no content. */
export type Response = { description: string } & ({ json: Schema } | { text: true } | { empty: true });

/**
 * A route: its method, its path, with a `{param}` per segment its params
 * schema names, the schemas its params, query and JSON body are checked with,
 * and each response it answers, by status.
 */
export type Route = {
  method: "get" | "post" | "put" | "delete";
  path: string;
  params?: Schema;
  query?: Schema;
  body?: Schema;
  responses: { [status: number]: Response };
};

/** A route, as `routes/` declares it. Its exact type is kept, so serving and calling it are checked against it. */
export const defineRoute = <const R extends Route>(r: R) => r;

/** A route's responses: JSON its schema reads, text, and no content. */
export const route = {
  json: <S extends Schema>(schema: S, description = "json") => ({ description, json: schema }),
  text: (description: string) => ({ description, text: true as const }),
  empty: (description = "no content") => ({ description, empty: true as const }),
};

type In<S> = S extends Schema ? StandardSchemaV1.InferInput<S> : never;
type Out<S> = S extends Schema ? StandardSchemaV1.InferOutput<S> : never;
type Part<R, K extends string> = R extends { [P in K]: infer S } ? S : undefined;
type DropNever<T> = { [K in keyof T as [T[K]] extends [never] ? never : K]: T[K] };

/** What a handler reads with `c.req.valid`: its route's params, query and body, as their schemas output them. */
type Valid<R extends Route> = { out: DropNever<{ param: Out<Part<R, "params">>; query: Out<Part<R, "query">>; json: Out<Part<R, "body">> }> };

/** A response's status, by its key: a number, or a numeric string, as a spread of responses keys them. */
type StatusOf<K> = K extends number ? K : K extends `${infer N extends number}` ? N : never;

type ReplyTo<D, S extends StatusCode> = D extends { json: infer J } ? TypedResponse<JSONParsed<Out<J>>, S, "json"> : D extends { text: true } ? TypedResponse<string, S, "text"> : TypedResponse<null, S, "body">;

/** Each response a route declares, as its handler must answer it: JSON with `c.json`, text with `c.text`, no content with `c.body(null, status)`. */
type Reply<R extends Route> = { [K in keyof R["responses"]]: StatusOf<K> extends infer S extends StatusCode ? ReplyTo<R["responses"][K], S> : never }[keyof R["responses"]];

/** A route's handler. `E` is its app's env, for a handler that reads what its app's middleware set. */
export type RouteHandler<R extends Route, E extends Env = Env> = (c: Context<E, string, Valid<R>>) => Reply<R> | Promise<Reply<R>>;

/** A request a route's schemas refuse: 400, with what's wrong. */
const refuse = (result: { success: boolean; error?: readonly StandardSchemaV1.Issue[] }, c: Context) => {
  if (!result.success) return c.text(`bad request: ${schemas.firstIssue(result.error ?? [])}`, 400);
};

/** Serves `r` on `app` with `fn`, which answers only requests whose params, query and body its schemas accept. */
export const serve = <E extends Env, R extends Route>(app: Hono<E>, r: R, fn: RouteHandler<R, E>) => {
  const checks = [r.params && sValidator("param", r.params, refuse), r.query && sValidator("query", r.query, refuse), r.body && sValidator("json", r.body, refuse)];
  const handlers = [...checks.filter((check) => check !== undefined), fn] as unknown as MiddlewareHandler<E>[];
  // Hono types each handler of a route by the validators before it, which a list built at runtime can't be: `fn`'s type is checked against the route instead.
  const on = app.on.bind(app) as unknown as (method: string, path: string, ...handlers: MiddlewareHandler<E>[]) => Hono<E>;
  return on(r.method.toUpperCase(), r.path.replaceAll(/\{(\w+)\}/g, ":$1"), ...handlers);
};

/** A request as a client sends it: the body is JSON text, so a fetcher can sign it. */
export type RouteRequest = { method: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal };

/** Sends a request to `path`, relative to the service's base, e.g. `/repos/acme/w`. The base URL and signing or a bearer token are the fetcher's. */
export type RouteFetcher = (path: string, init: RouteRequest) => Promise<globalThis.Response>;

type Query<R extends Route> = [In<Part<R, "query">>] extends [never] ? {} : {} extends In<Part<R, "query">> ? { query?: In<Part<R, "query">> } : { query: In<Part<R, "query">> };

/** What a call takes: the route's declared params, query and JSON body, by those names. A query whose every field is optional may be left out. */
export type RouteArgs<R extends Route> = DropNever<{ params: In<Part<R, "params">>; body: In<Part<R, "body">> }> & Query<R>;

type ResponseValue<D> = D extends { json: infer J } ? Out<J> : D extends { text: true } ? string : void;
/** What a call resolves to: the union of the route's declared 2xx responses, JSON as its schema reads it, text, or `void` for no content. */
export type RouteResult<R extends Route> = { [K in keyof R["responses"]]: StatusOf<K> extends SuccessStatusCode ? ResponseValue<R["responses"][K]> : never }[keyof R["responses"]];

export type RouteCall<R extends Route> = keyof RouteArgs<R> extends never
  ? () => Promise<RouteResult<R>>
  : {} extends RouteArgs<R>
    ? (args?: RouteArgs<R>) => Promise<RouteResult<R>>
    : (args: RouteArgs<R>) => Promise<RouteResult<R>>;
export type RouteClient<Routes extends Record<string, Route>> = { [K in keyof Routes]: RouteCall<Routes[K]> };

const SUCCESS = 2;

/**
 * A client for `routes`: one method per route, by its key. It fills `{param}`s
 * in the path, checks the request against the route's schemas before sending
 * it, and reads a 2xx answer as the route declares it. Any other answer, or a
 * 2xx the route doesn't declare, throws an HttpError naming `service`, e.g.
 * `Router GET /installed: 401 bad signature`.
 */
export const routeClient = <const Routes extends Record<string, Route>>(routes: Routes, fetcher: RouteFetcher, { service }: { service?: string } = {}) => {
  const named = (method: string, path: string) => `${service ? `${service} ` : ""}${method} ${path}`;
  const call =
    (r: Route) =>
    async (args: { params?: unknown; query?: unknown; body?: unknown } = {}) => {
      const method = r.method.toUpperCase();
      const check = async (s: Schema | undefined, value: unknown, what: string) => {
        if (!s) return undefined;
        try {
          return (await schemas.parse(s, value)) as Record<string, unknown>;
        } catch (error) {
          throw new Error(`${named(method, r.path)}: its ${what} ${errors.message(error)}`);
        }
      };
      const params = (await check(r.params, args.params, "params")) ?? {};
      const query = await check(r.query, args.query ?? {}, "query");
      // Checked, but sent as given: the server reads it again, and a transform's output needn't be its input.
      await check(r.body, args.body, "body");
      const path = r.path.replaceAll(/\{(\w+)\}/g, (_, name: string) => {
        if (params[name] === undefined) throw new Error(`${method} ${r.path}: no "${name}" param`);
        return encodeURIComponent(String(params[name]));
      });
      const entries = Object.entries(query ?? {}).filter(([, value]) => value !== undefined);
      const search = entries.length ? `?${new URLSearchParams(entries.map(([k, value]): [string, string] => [k, String(value)]))}` : "";
      const body = args.body === undefined ? undefined : JSON.stringify(args.body);
      const res = await fetcher(path + search, { method, body, headers: body === undefined ? undefined : { "content-type": "application/json" } });
      const text = await res.text();
      if (Math.floor(res.status / 100) !== SUCCESS) throw new HttpError(res.status, method, path, text, service);
      const declared = r.responses[res.status];
      if (!declared) throw new Error(`${named(method, path)}: ${res.status}, which the route doesn't declare`);
      if ("empty" in declared) return undefined;
      if ("text" in declared) return text;
      // Not an HttpError: it answered, but not as the route says, so its status says nothing.
      const unreadable = (why: string) => new Error(`${named(method, path)}: ${res.status} isn't what the route declares: ${why}`);
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw unreadable(`not JSON: ${http.excerpt(text)}`);
      }
      try {
        return await schemas.parse(declared.json, value);
      } catch (error) {
        throw unreadable(errors.message(error));
      }
    };
  return Object.fromEntries(Object.entries(routes).map(([name, r]) => [name, call(r)])) as RouteClient<Routes>;
};
