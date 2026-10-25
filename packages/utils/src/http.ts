import type { RouteConfig, RouteConfigToTypedResponse, RouteHandler } from "@hono/zod-openapi";
import { type Env, Hono, type TypedResponse } from "hono";
import type { StatusCode, SuccessStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { errors } from "./errors.ts";

/** How much of an error response's body goes into an error message: enough to read, not a whole HTML page. */
const ERROR_BODY_CHARS = 500;

/** A response a client didn't want, e.g. `Router GET /admin/installed: 401 bad signature`. `service` names who answered. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string,
    readonly service?: string,
  ) {
    super(`${service ? `${service} ` : ""}${method} ${path}: ${status} ${http.excerpt(body)}`.trimEnd());
  }
}

export const http = {
  /** As much of a response body as an error message quotes: an HTML page's title, as its markup says nothing. */
  excerpt: (body: string) => {
    const title = /^\s*<(!doctype|html)/i.test(body) ? body.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() : undefined;
    return title ?? body.slice(0, ERROR_BODY_CHARS);
  },

  /** An error for a response that wasn't 2xx, e.g. `The router refused credentials: 403 forbidden`. Reads the body. */
  responseError: async (res: Response, what: string) => new Error(`${what}: ${res.status} ${http.excerpt(await res.text())}`.trimEnd()),

  expectOk: async (res: Response, what: string) => {
    if (!res.ok) throw await http.responseError(res, what);
    return res;
  },

  bearerToken: (req: Request) => req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1],

  /** An app that answers health on `GET /`, 404s what it doesn't route, and 500s an error, logging it without leaking it. */
  service: (log: (line: string) => void) =>
    new Hono()
      .get("/", (c) => c.text("ok"))
      .notFound((c) => c.text("not found", 404))
      .onError((error, c) => {
        log(`${c.req.method} ${c.req.path}: ${errors.detail(error)}`);
        return c.text("internal error", 500);
      }),
};

/** Pieces of a `createRoute` declaration: a required JSON body, and JSON, text and empty responses. */
export const route = {
  /** A JSON request body. `required`, or OpenAPIHono skips validating a request without a JSON content type. */
  body: <S extends z.ZodType>(schema: S) => ({ required: true, content: { "application/json": { schema } } }),
  json: <S extends z.ZodType>(schema: S, description = "json") => ({ description, content: { "application/json": { schema } } }),
  text: (description: string) => ({ description, content: { "text/plain": { schema: z.string() } } }),
  empty: (description = "no content") => ({ description }),
};

/** Each response a route declares, as its handler must answer it: one without content is `c.body(null, status)`. */
type Reply<R extends RouteConfig> = {
  [S in keyof R["responses"] & StatusCode]: R["responses"][S] extends { content: object }
    ? Extract<RouteConfigToTypedResponse<R>, { _status: S }>
    : TypedResponse<null, S, "body">;
}[keyof R["responses"] & StatusCode];

/**
 * `fn`, checked against every response `route` declares. OpenAPIHono checks a
 * handler's answers only when all of a route's responses have content: one
 * without, e.g. a 204, lets the handler answer any Response. `E` is the app's
 * env, for a handler that reads what its app's middleware set.
 */
export const handler = <R extends RouteConfig, E extends Env = Env>(_route: R, fn: (c: Parameters<RouteHandler<R, E>>[0]) => Reply<R> | Promise<Reply<R>>) =>
  fn as unknown as RouteHandler<R, E>;

/** A request as a client sends it: the body is JSON text, so a fetcher can sign it. */
export type RouteRequest = { method: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal };

/** Sends a request to `path`, relative to the service's base, e.g. `/repos/acme/w`. The base URL and signing or a bearer token are the fetcher's. */
export type RouteFetcher = (path: string, init: RouteRequest) => Promise<Response>;

type Zod<T> = T extends z.ZodType ? T : never;
type RequestPart<R extends RouteConfig, K extends string> = R["request"] extends Record<K, infer S> ? z.input<Zod<S>> : never;
type RequestBody<R extends RouteConfig> = R["request"] extends { body: { content: { "application/json": { schema: infer S } } } } ? z.input<Zod<S>> : never;
type DropNever<T> = { [K in keyof T as [T[K]] extends [never] ? never : K]: T[K] };

type Query<R extends RouteConfig> = [RequestPart<R, "query">] extends [never] ? {} : {} extends RequestPart<R, "query"> ? { query?: RequestPart<R, "query"> } : { query: RequestPart<R, "query"> };

/** What a call takes: the route's declared params, query and JSON body, by those names. A query whose every field is optional may be left out. */
export type RouteArgs<R extends RouteConfig> = DropNever<{ params: RequestPart<R, "params">; body: RequestBody<R> }> & Query<R>;

type ResponseValue<Res> = Res extends { content: infer C } ? (C[keyof C] extends { schema: infer S } ? z.output<Zod<S>> : unknown) : void;
/** What a call resolves to: the union of the route's declared 2xx responses. JSON and text are parsed with their schema; no content is `void`. */
export type RouteResult<R extends RouteConfig> = {
  [S in keyof R["responses"]]: S extends SuccessStatusCode | `${SuccessStatusCode}` | "2XX" ? ResponseValue<R["responses"][S]> : never;
}[keyof R["responses"]];

export type RouteCall<R extends RouteConfig> = keyof RouteArgs<R> extends never
  ? () => Promise<RouteResult<R>>
  : {} extends RouteArgs<R>
    ? (args?: RouteArgs<R>) => Promise<RouteResult<R>>
    : (args: RouteArgs<R>) => Promise<RouteResult<R>>;
export type RouteClient<Routes extends Record<string, RouteConfig>> = { [K in keyof Routes]: RouteCall<Routes[K]> };

const isZod = (value: unknown): value is z.ZodType => value instanceof z.ZodType;
/** A media type object's zod schema: a `$ref` or a plain OpenAPI schema has none. */
const schemaOf = (media: unknown) => (media && typeof media === "object" && "schema" in media && isZod(media.schema) ? media.schema : undefined);
const SUCCESS = 2;

/** The first thing wrong with a value, e.g. `containers.0.name: expected string`. */
const firstIssue = (error: z.ZodError) => {
  const issue = error.issues[0];
  if (!issue) return "invalid";
  return issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
};

/**
 * A client for `routes`, each a `createRoute` declaration: one method per route,
 * by its key. It fills `{param}`s in the path, validates the request against
 * the route's schemas before sending it, and parses a 2xx answer with the
 * response's schema. Any other answer, or a 2xx the route doesn't declare,
 * throws an HttpError naming `service`, e.g. `Router GET /installed: 401 bad signature`.
 */
export const routeClient = <const Routes extends Record<string, RouteConfig>>(routes: Routes, fetcher: RouteFetcher, { service }: { service?: string } = {}) => {
  const call =
    (r: RouteConfig) =>
    async (args: { params?: unknown; query?: unknown; body?: unknown } = {}) => {
      const request = r.request ?? {};
      const params = isZod(request.params) ? (request.params.parse(args.params) as Record<string, unknown>) : {};
      const query = isZod(request.query) ? (request.query.parse(args.query ?? {}) as Record<string, unknown>) : undefined;
      const bodySchema = schemaOf(request.body?.content["application/json"]);
      // Validated, but sent as given: the server parses it again, and a transform's output needn't be its input.
      if (bodySchema) bodySchema.parse(args.body);
      const method = r.method.toUpperCase();
      const path = r.path.replaceAll(/\{(\w+)\}/g, (_, name: string) => {
        if (params[name] === undefined) throw new Error(`${method} ${r.path}: no "${name}" param`);
        return encodeURIComponent(String(params[name]));
      });
      const entries = Object.entries(query ?? {}).filter(([, v]) => v !== undefined);
      const search = entries.length ? `?${new URLSearchParams(entries.map(([k, v]): [string, string] => [k, String(v)]))}` : "";
      const body = args.body === undefined ? undefined : JSON.stringify(args.body);
      const res = await fetcher(path + search, { method, body, headers: body === undefined ? undefined : { "content-type": "application/json" } });
      const text = await res.text();
      if (Math.floor(res.status / 100) !== SUCCESS) throw new HttpError(res.status, method, path, text, service);
      const declared = r.responses[res.status] ?? r.responses[`${SUCCESS}XX`];
      if (!declared) throw new Error(`${service ? `${service} ` : ""}${method} ${path}: ${res.status}, which the route doesn't declare`);
      const [mediaType, media] = Object.entries(("content" in declared && declared.content) || {})[0] ?? [];
      if (!mediaType) return undefined;
      // Not an HttpError: it answered, but not as the route says, so its status says nothing.
      const unreadable = (why: string) => new Error(`${service ? `${service} ` : ""}${method} ${path}: ${res.status} isn't what the route declares: ${why}`);
      let value: unknown = text;
      if (/json/.test(mediaType)) {
        try {
          value = JSON.parse(text);
        } catch {
          throw unreadable(`not JSON: ${http.excerpt(text)}`);
        }
      }
      const parsed = (schemaOf(media) ?? z.unknown()).safeParse(value);
      if (!parsed.success) throw unreadable(firstIssue(parsed.error));
      return parsed.data;
    };
  return Object.fromEntries(Object.entries(routes).map(([name, r]) => [name, call(r)])) as RouteClient<Routes>;
};
