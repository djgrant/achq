// Requests between achq's services are signed over the method, path, timestamp
// and body, so a captured request can't be replayed elsewhere or later.
import { hmacHex, safeEqual } from "@achq/utils/crypto";
import { adminSecret } from "./secrets.ts";

export { hmacHex, safeEqual };

const MAX_SKEW_MS = 5 * 60_000;
const TIMESTAMP_HEADER = "x-achq-timestamp";
const SIGNATURE_HEADER = "x-achq-signature";

const signature = (secret: string, method: string, path: string, timestamp: string, body: string) =>
  hmacHex(secret, `${method.toUpperCase()}\n${path}\n${timestamp}\n${body}`);

const signedPath = (url: string) => {
  const { pathname, search } = new URL(url);
  return pathname + search;
};

export const signedHeaders = (secret: string, method: string, path: string, body: string, now = Date.now()) => {
  const timestamp = String(now);
  return { [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: signature(secret, method, path, timestamp, body) };
};

export const verifySigned = (secret: string, method: string, path: string, body: string, headers: Headers, now = Date.now()) => {
  const timestamp = headers.get(TIMESTAMP_HEADER);
  const signed = headers.get(SIGNATURE_HEADER);
  if (!timestamp || !signed || Math.abs(now - Number(timestamp)) > MAX_SKEW_MS) return false;
  return safeEqual(signed, signature(secret, method, path, timestamp, body));
};

const bodyHeaders = (body: string | undefined): Record<string, string> => (body === undefined ? {} : { "content-type": "application/json" });

/** Sign each attempt afresh: a retry can outlast the timestamp's window. */
export const signedRequestInit = (
  secret: string,
  method: string,
  url: string,
  body?: string,
  { now = Date.now(), signal, headers }: { now?: number; signal?: AbortSignal; headers?: Record<string, string> } = {},
): RequestInit => ({
  method,
  body,
  signal,
  headers: { ...headers, ...bodyHeaders(body), ...signedHeaders(secret, method, signedPath(url), body ?? "", now) },
});

/** The signature covers `url`'s path and query. */
export const signedFetch = (secret: string, url: string, init: { method: string; body?: string; headers?: Record<string, string> }) =>
  fetch(url, signedRequestInit(secret, init.method, url, init.body, { headers: init.headers }));

/** Reads the body. */
export const verifySignedRequest = async (req: Request, secret: string, now = Date.now()): Promise<{ body: string } | undefined> => {
  const body = await req.text();
  return verifySigned(secret, req.method, signedPath(req.url), body, req.headers, now) ? { body } : undefined;
};

/** `verifySignedRequest` with the admin secret derived from AGENT_WEBHOOK_KEY: requests from the router, the deployer and the infra CLI. */
export const verifyAdminRequest = (req: Request, key: string, now = Date.now()) => verifySignedRequest(req, adminSecret(key), now);
