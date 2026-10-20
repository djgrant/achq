import type { WakeRequest } from "@achq/core";
import { bearerToken, parseBody, textResponse } from "@achq/utils/http";
import { configOf, type RouterContext } from "../context.ts";
import { reach } from "../reach.ts";
import { wakeRequestSchema } from "../requests.ts";

const codeHostOf = (ctx: RouterContext, id: string) => (Object.hasOwn(ctx.codeHostProviders, id) ? ctx.codeHostProviders[id] : undefined);

/** The container the request names, if its repo is deployed from the host the request names. */
const deployedContainer = (ctx: RouterContext, request: WakeRequest) => {
  const config = configOf(ctx, request.repo);
  return config?.host === request.host ? config.containers.find((c) => c.name === request.container) : undefined;
};

/** For `achq ssh`: wakes a container for someone who can push to its repo, on the host it's deployed from. */
export const wake = async (ctx: RouterContext, req: Request) => {
  const token = bearerToken(req);
  if (!token) return textResponse("missing token", 401);
  const request = parseBody(wakeRequestSchema, await req.text());
  if (!request) return textResponse("bad request", 400);
  const host = codeHostOf(ctx, request.host);
  if (!host) return textResponse("unknown host", 400);
  // Checked before saying whether the repo is deployed, so strangers learn nothing.
  if (!(await host.canPush(request.repo, token))) return textResponse("no push access", 403);
  const container = deployedContainer(ctx, request);
  if (!container) return textResponse("not deployed", 404);

  // Any request wakes it; its health check answers once it's up.
  const result = await reach(ctx.delays, (signal) => ctx.fetch(`${container.url}/`, { signal }), ctx.attemptTimeout);
  if (!result.ok) return textResponse(result.error, 504);
  await result.res.body?.cancel();
  return textResponse("awake");
};
