import { adminSecret } from "@achq/core/secrets";
import { signedFetcher, signedRequestInit } from "@achq/core/signing";
import { async, type Attempt } from "@achq/utils/async";
import type { RouteFetcher } from "@achq/utils/http";
import type { RouterContext } from "../context.ts";

/** What a service that never answered is, as a response: the router gave up waiting for it. */
const GATEWAY_TIMEOUT = 504;

/** A status from here up means the service isn't answering yet, so it's worth trying again. */
const SERVER_ERROR = 500;

/** Sign each attempt afresh: a retry can outlast the timestamp's window. */
export const fetchSigned = (ctx: RouterContext, secret: string, method: string, url: string, body?: string, signal?: AbortSignal) =>
  ctx.fetch(url, signedRequestInit(secret, method, url, body, { now: ctx.now(), signal }));

/**
 * Attempts at once and after each of `delays` until a service answers with
 * anything but a 5xx, as a sleeping one does once it's up. `timeout` limits
 * each attempt.
 */
export const reach = async (
  delays: readonly number[],
  attempt: (signal?: AbortSignal) => Promise<Response>,
  timeout?: number,
): Promise<{ ok: true; res: Response } | { ok: false; error: string }> => {
  const result = await async.retry(async (): Promise<Attempt<Response>> => {
    const res = await attempt(timeout ? AbortSignal.timeout(timeout) : undefined);
    if (res.status < SERVER_ERROR) return { ok: true, value: res };
    return { ok: false, error: `${res.status} ${await res.text()}`.trim() };
  }, delays);
  if (result.ok) return { ok: true, res: result.value };
  return { ok: false, error: `gave up after ${result.attempts} attempts (${result.error})` };
};

/**
 * The deployer, as its client's fetcher: signed with the admin secret, and
 * through `reach`, so a sleeping one is woken. One that never answers is a
 * 504 with why; any answer it gives, a refusal among them, is its own.
 */
export const toDeployer = (ctx: RouterContext) => {
  const signed = signedFetcher(adminSecret(ctx.env.key), ctx.env.deployerUrl, { fetch: ctx.fetch, now: ctx.now });
  return (async (path, init) => {
    const result = await reach(ctx.delays, (signal) => signed(path, { ...init, signal }));
    return result.ok ? result.res : new Response(result.error, { status: GATEWAY_TIMEOUT });
  }) satisfies RouteFetcher;
};
