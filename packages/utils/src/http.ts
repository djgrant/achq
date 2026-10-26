// Plain HTTP helpers, with no framework: what a vendor's API client needs. Routes, and the Hono apps that serve them, are in routes.ts.

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
};
