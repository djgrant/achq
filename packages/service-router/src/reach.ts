import { signedHeaders } from "@achq/core/signing";
import type { RouterContext } from "./context.ts";
import { message } from "./errors.ts";

/** A request signed for `url`'s path. Signed per attempt, since retries outlast the timestamp's window. */
export const signed = (ctx: RouterContext, secret: string, method: string, url: string, body?: string, signal?: AbortSignal): RequestInit => {
  const { pathname, search } = new URL(url);
  return {
    method,
    body,
    signal,
    headers: { ...(body !== undefined && { "content-type": "application/json" }), ...signedHeaders(secret, method, pathname + search, body ?? "", ctx.now()) },
  };
};

/** Attempts until a service answers with anything but a 5xx. */
export const reach = async (ctx: RouterContext, attempt: (signal?: AbortSignal) => Promise<Response>, timeout?: number) => {
  let last = "";
  for (const delay of [0, ...ctx.delays]) {
    if (delay) await Bun.sleep(delay);
    try {
      const res = await attempt(timeout ? AbortSignal.timeout(timeout) : undefined);
      if (res.status < 500) return { ok: true as const, res };
      last = `${res.status} ${await res.text()}`.trim();
    } catch (e) {
      last = message(e);
    }
  }
  return { ok: false as const, error: `gave up after ${ctx.delays.length + 1} attempts (${last})` };
};
