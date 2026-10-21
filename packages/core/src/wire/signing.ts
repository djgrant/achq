import { crypto } from "@achq/utils/crypto";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

const MAX_SKEW_MS = 5 * 60_000;
const TIMESTAMP_HEADER = "x-achq-timestamp";
const SIGNATURE_HEADER = "x-achq-signature";

const signature = (secret: string, method: string, path: string, timestamp: string, body: string) =>
  crypto.hmacHex(secret, `${method.toUpperCase()}\n${path}\n${timestamp}\n${body}`);

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
  return crypto.safeEqual(signed, signature(secret, method, path, timestamp, body));
};

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
  headers: { ...headers, ...(body !== undefined && { "content-type": "application/json" }), ...signedHeaders(secret, method, signedPath(url), body ?? "", now) },
});

/** The signature covers `url`'s path and query. */
export const signedFetch = (secret: string, url: string, init: { method: string; body?: string; headers?: Record<string, string> }) =>
  fetch(url, signedRequestInit(secret, init.method, url, init.body, { headers: init.headers }));

/** Whether `secret` signed the request `c` handles. Reads its body. */
export const isSigned = async (c: Context, secret: string, now = Date.now()) =>
  verifySigned(secret, c.req.method, signedPath(c.req.url), await c.req.text(), c.req.raw.headers, now);

/** Answers 401 to a request `secret` didn't sign. */
export const signedBy = (secret: string, now: () => number = Date.now) =>
  createMiddleware(async (c, next) => ((await isSigned(c, secret, now())) ? next() : c.text("bad signature", 401)));
