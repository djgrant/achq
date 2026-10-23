import { Hono } from "hono";
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
    service?: string,
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

const NOT_FOUND = 404;

/**
 * JSON values by name at `base`: `GET base` lists the names, sorted; `GET`,
 * `PUT` and `DELETE` `base/<name>` read, write and remove one. A write is kept
 * once it's answered. Names are path segments, so they're encoded.
 */
export class HttpJsonStore<T> {
  constructor(
    readonly base: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private url(name: string) {
    return `${this.base}/${encodeURIComponent(name)}`;
  }

  private async call(method: string, url: string, body?: string) {
    const res = await this.fetcher(url, { method, body, headers: body === undefined ? undefined : { "content-type": "application/json" } });
    if (method === "GET" && res.status === NOT_FOUND) return undefined;
    if (!res.ok) throw new HttpError(res.status, method, new URL(url).pathname, await res.text(), "Store");
    return res.text();
  }

  async read(name: string) {
    const text = await this.call("GET", this.url(name));
    return text === undefined ? undefined : (JSON.parse(text) as T);
  }

  async write(name: string, value: T) {
    await this.call("PUT", this.url(name), JSON.stringify(value));
  }

  async remove(name: string) {
    await this.call("DELETE", this.url(name));
  }

  async list() {
    const text = await this.call("GET", this.base);
    return text ? (JSON.parse(text) as string[]) : [];
  }

  async all() {
    const values = await Promise.all((await this.list()).map((name) => this.read(name)));
    // A name removed while listing reads as undefined.
    return values.filter((v) => v !== undefined) as T[];
  }
}
