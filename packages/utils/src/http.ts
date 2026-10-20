// HTTP on both sides: responses a handler gives, request bodies it checks, and
// the errors a client raises for responses it didn't want.
import { errorDetail } from "./errors.ts";

/** How much of an error response's body goes into an error message: enough to read, not a whole HTML page. */
export const ERROR_BODY_CHARS = 500;

const excerpt = (body: string) => body.slice(0, ERROR_BODY_CHARS);

/** A response a client didn't want, e.g. `GitHub GET /repos/a/b: 404 Not Found`. `service` names who answered. */
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

/** `res`, or the `responseError` for it if it isn't 2xx. */
export const expectOk = async (res: Response, what: string): Promise<Response> => {
  if (!res.ok) throw await responseError(res, what);
  return res;
};

export const textResponse = (body: string, status = 200) => new Response(body, { status });
export const jsonResponse = (value: unknown, status = 200) => Response.json(value, { status });
export const noContent = () => new Response(null, { status: 204 });

/** The token in an `Authorization: Bearer …` header. */
export const bearerToken = (req: Request): string | undefined => req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];

/** A request body as an object, or undefined if it isn't JSON or isn't an object. Its fields still need checking. */
export const parseObject = <T>(body: string): Partial<T> | undefined => {
  const value = parseJson(body);
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Partial<T>) : undefined;
};

/** Anything with zod's `safeParse`, so this module doesn't depend on zod. */
export type Schema<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };

/** A request body checked against `schema`, or undefined if it isn't JSON or doesn't fit. An empty body is `{}`. */
export const parseBody = <T>(schema: Schema<T>, body: string): T | undefined => {
  const value = body ? parseJson(body) : {};
  if (value === undefined) return undefined;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const parseJson = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

export type Handle = (req: Request, url: URL) => Promise<Response | undefined> | Response | undefined;

/** `handle`, with health on `GET /`, a 404 for what it leaves unhandled, and a 500 that logs the error but doesn't leak it. */
export const withHealthAndErrors = (handle: Handle, log: (line: string) => void) => async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/") return textResponse("ok");
  try {
    return (await handle(req, url)) ?? textResponse("not found", 404);
  } catch (e) {
    log(`${req.method} ${url.pathname}: ${errorDetail(e)}`);
    return textResponse("internal error", 500);
  }
};
