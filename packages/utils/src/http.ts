import { Hono } from "hono";
import { errors } from "./errors.ts";

/** How much of an error response's body goes into an error message: enough to read, not a whole HTML page. */
const ERROR_BODY_CHARS = 500;

/** How often a long answer sends a space: under every hop's idle timeout, the shortest being Bun's server's 10 seconds. */
const KEEPALIVE_MS = 5_000;

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
  /** As much of a response body as an error message quotes. */
  excerpt: (body: string) => body.slice(0, ERROR_BODY_CHARS),

  /** An error for a response that wasn't 2xx, e.g. `The router refused credentials: 403 forbidden`. Reads the body. */
  responseError: async (res: Response, what: string) => new Error(`${what}: ${res.status} ${http.excerpt(await res.text())}`.trimEnd()),

  expectOk: async (res: Response, what: string) => {
    if (!res.ok) throw await http.responseError(res, what);
    return res;
  },

  /**
   * `work`'s JSON, after a space every few seconds until it settles, so no hop
   * closes a long request as idle: JSON parses with spaces before it. The
   * status goes first, so if it throws, it's `{ error: "internal error" }`,
   * logging the error without leaking it.
   */
  longAnswer: (work: Promise<unknown>, log: (line: string) => void, intervalMs = KEEPALIVE_MS) => {
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        timer = setInterval(() => controller.enqueue(encoder.encode(" ")), intervalMs);
        work
          .then(
            (value) => JSON.stringify(value),
            (error) => {
              log(errors.detail(error));
              return JSON.stringify({ error: "internal error" });
            },
          )
          .then((json) => {
            clearInterval(timer);
            controller.enqueue(encoder.encode(json));
            controller.close();
          });
      },
      cancel: () => clearInterval(timer),
    });
    return new Response(body, { headers: { "content-type": "application/json" } });
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
