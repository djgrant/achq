import { Hono } from "hono";
import { errorDetail } from "./errors.ts";

/** How much of an error response's body goes into an error message: enough to read, not a whole HTML page. */
export const ERROR_BODY_CHARS = 500;

const excerpt = (body: string) => body.slice(0, ERROR_BODY_CHARS);

/** A response a client didn't want, e.g. `Router GET /admin/installed: 401 bad signature`. `service` names who answered. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string,
    service?: string,
  ) {
    super(`${service ? `${service} ` : ""}${method} ${path}: ${status} ${excerpt(body)}`.trimEnd());
  }
}

/** An error for a response that wasn't 2xx, e.g. `The router refused credentials: 403 forbidden`. Reads the body. */
export const responseError = async (res: Response, what: string): Promise<Error> =>
  new Error(`${what}: ${res.status} ${excerpt(await res.text())}`.trimEnd());

export const expectOk = async (res: Response, what: string): Promise<Response> => {
  if (!res.ok) throw await responseError(res, what);
  return res;
};

export const bearerToken = (req: Request): string | undefined => req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];

/** An app that answers health on `GET /`, 404s what it doesn't route, and 500s an error, logging it without leaking it. */
export const service = (log: (line: string) => void) =>
  new Hono()
    .get("/", (c) => c.text("ok"))
    .notFound((c) => c.text("not found", 404))
    .onError((error, c) => {
      log(`${c.req.method} ${c.req.path}: ${errorDetail(error)}`);
      return c.text("internal error", 500);
    });
