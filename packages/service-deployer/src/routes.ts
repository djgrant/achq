import { deployerRoutes } from "@achq/core/routes/deployer";
import { adminSecret } from "@achq/core/secrets";
import { signedBy } from "@achq/core/signing";
import { serve, service } from "@achq/utils/routes";
import { Hono } from "hono";
import type { DeployerContext } from "./context.ts";
import { shell, status } from "./features/deploy.ts";
import { handleEvent } from "./features/events.ts";
import { sync } from "./features/sync.ts";

/**
 * The deployer's app, as `@achq/core/routes/deployer` declares it, and how it's
 * served. Every route but health takes only requests signed with the admin
 * secret. A sync runs in the background, kept in the deployer's store so a
 * restart doesn't lose it: one that stopped when its deployer did is interrupted.
 */
export const routes = (ctx: DeployerContext) => {
  const deployer = new Hono();
  deployer.use(signedBy(adminSecret(ctx.env.key)));
  serve(deployer, deployerRoutes.events, async (c) => {
    // Answered once handled, so the router keeps the delivery until it's done.
    await handleEvent(ctx, c.req.valid("json"));
    return c.body(null, 202);
  });
  serve(deployer, deployerRoutes.sync, async (c) => {
    const request = c.req.valid("json");
    return c.json({ id: await ctx.store.syncs.start(() => sync(ctx, request)) }, 202);
  });
  serve(deployer, deployerRoutes.syncStatus, async (c) => {
    const found = await ctx.store.syncs.status(c.req.valid("param").id);
    if (!found) return c.text("no such sync", 404);
    // A failed one's error is only logged.
    return c.json(found.state === "failed" ? { state: "failed" as const } : found, 200);
  });
  serve(deployer, deployerRoutes.version, (c) => c.json({ version: ctx.env.version, plugins: ctx.env.plugins }, 200));
  serve(deployer, deployerRoutes.status, async (c) => c.json(await status(ctx), 200));
  serve(deployer, deployerRoutes.shell, async (c) => {
    const found = await shell(ctx, c.req.valid("json"));
    return found ? c.json(found, 200) : c.text("no such container", 404);
  });
  return {
    deployer,
    fetch: service((line) => ctx.log(`deployer ${line}`)).route("/", deployer).fetch,
  };
};
