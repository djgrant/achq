import { WakeRequest } from "@achq/core/protocol";
import { bearerToken } from "@achq/utils/http";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { REPO } from "../constants.ts";
import { configOf, type RouterContext } from "../context.ts";
import { reach } from "../reach.ts";

const codeHostOf = (ctx: RouterContext, id: string) => (Object.hasOwn(ctx.codeHostProviders, id) ? ctx.codeHostProviders[id] : undefined);

/** The container the request names, if its repo is deployed from the host the request names. */
const deployedContainer = (ctx: RouterContext, request: WakeRequest) => {
  const config = configOf(ctx, request.repo);
  return config?.host === request.host ? config.containers.find((c) => c.name === request.container) : undefined;
};

/** For `achq container ssh`: wakes a container for someone who can push to its repo, on the host it's deployed from. */
export const wake = (ctx: RouterContext) =>
  new Hono().post("/wake", zValidator("json", WakeRequest), async (c) => {
    const token = bearerToken(c.req.raw);
    if (!token) return c.text("missing token", 401);
    const request = c.req.valid("json");
    if (!REPO.test(request.repo)) return c.text("bad request", 400);
    const host = codeHostOf(ctx, request.host);
    if (!host) return c.text("unknown host", 400);
    // Checked before saying whether the repo is deployed, so strangers learn nothing.
    if (!(await host.canPush(request.repo, token))) return c.text("no push access", 403);
    const container = deployedContainer(ctx, request);
    if (!container) return c.text("not deployed", 404);

    // Any request wakes it; its health check answers once it's up.
    const result = await reach(ctx.delays, (signal) => ctx.fetch(`${container.url}/`, { signal }), ctx.attemptTimeout);
    if (!result.ok) return c.text(result.error, 504);
    await result.res.body?.cancel();
    return c.text("awake");
  });
