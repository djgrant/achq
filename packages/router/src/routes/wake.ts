import type { WakeRequest } from "@achq/core";
import { REPO } from "../constants.ts";
import { configOf, type RouterContext } from "../context.ts";
import { parse, text } from "../http.ts";
import { reach } from "../reach.ts";

/** For `achq ssh`: wakes a container for someone who can push to its repo, on the host it's deployed from. */
export const wake = async (ctx: RouterContext, req: Request) => {
  const token = req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) return text("missing token", 401);
  const request = parse<WakeRequest>(await req.text());
  if (typeof request?.host !== "string" || typeof request.repo !== "string" || !REPO.test(request.repo) || typeof request.container !== "string") return text("bad request", 400);
  const host = Object.hasOwn(ctx.hosts, request.host) ? ctx.hosts[request.host] : undefined;
  if (!host) return text("unknown host", 400);
  // Checked before saying whether the repo is deployed, so strangers learn nothing.
  if (!(await host.canPush(request.repo, token))) return text("no push access", 403);
  const config = configOf(ctx, request.repo);
  const container = config?.host === request.host ? config.containers.find((c) => c.name === request.container) : undefined;
  if (!container) return text("not deployed", 404);
  const result = await reach(ctx, (signal) => ctx.fetch(`${container.url}/`, { signal }), ctx.attemptTimeout);
  if (!result.ok) return text(result.error, 504);
  await result.res.body?.cancel();
  return text("awake");
};
