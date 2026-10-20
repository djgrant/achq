import { signedRequestInit } from "@achq/core/signing";
import { type Attempt, retry } from "@achq/utils/async";
import type { RouterContext } from "./context.ts";

/** A status from here up means the service isn't answering yet, so it's worth trying again. */
const SERVER_ERROR = 500;

export type Reached = { ok: true; res: Response } | { ok: false; error: string };

export type Try = (signal?: AbortSignal) => Promise<Response>;

/** Sign each attempt afresh: a retry can outlast the timestamp's window. */
export const fetchSigned = (ctx: RouterContext, secret: string, method: string, url: string, body?: string, signal?: AbortSignal) =>
  ctx.fetch(url, signedRequestInit(secret, method, url, body, { now: ctx.now(), signal }));

/** A 5xx is a failed attempt; anything else is the service's answer. */
const attemptOnce = async (tryOnce: Try, timeout?: number): Promise<Attempt<Response>> => {
  const res = await tryOnce(timeout ? AbortSignal.timeout(timeout) : undefined);
  if (res.status < SERVER_ERROR) return { ok: true, value: res };
  return { ok: false, error: `${res.status} ${await res.text()}`.trim() };
};

/** Attempts at once and after each of `delays` until a service answers with anything but a 5xx. */
export const reach = async (delays: readonly number[], tryOnce: Try, timeout?: number): Promise<Reached> => {
  const result = await retry(() => attemptOnce(tryOnce, timeout), delays);
  if (result.ok) return { ok: true, res: result.value };
  return { ok: false, error: `gave up after ${result.attempts} attempts (${result.error})` };
};
