import { deployerRoutes } from "@achq/core/routes/deployer";
import { adminSecret } from "@achq/core/secrets";
import { signedBy } from "@achq/core/signing";
import { handler, http } from "@achq/utils/http";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Deployer } from "./deployer.ts";

/**
 * The deployer's routes, as `@achq/core/routes/deployer` declares them. Every
 * one but health takes only requests signed with the admin secret. A sync runs
 * in the background, kept in the deployer's store so a restart doesn't lose
 * it: one that stopped when its deployer did is interrupted.
 */
export const deployerHandler = (deployer: Deployer, key: string, log: (line: string) => void = console.error) => {
  const routes = new OpenAPIHono();
  // On its own: chained, `use` returns a plain Hono, which has no `openapi`.
  routes.use(signedBy(adminSecret(key)));
  routes
    .openapi(
      deployerRoutes.events,
      handler(deployerRoutes.events, async (c) => {
        // Answered once handled, so the router keeps the delivery until it's done.
        await deployer.handle(c.req.valid("json"));
        return c.body(null, 202);
      }),
    )
    .openapi(deployerRoutes.sync, async (c) => {
      const request = c.req.valid("json");
      return c.json({ id: await deployer.syncs.start(() => deployer.sync(request)) }, 202);
    })
    .openapi(deployerRoutes.syncStatus, async (c) => {
      const status = await deployer.syncs.status(c.req.valid("param").id);
      if (!status) return c.text("no such sync", 404);
      // A failed one's error is only logged.
      return c.json(status.state === "failed" ? { state: "failed" as const } : status, 200);
    })
    .openapi(deployerRoutes.version, (c) => c.json({ ref: deployer.ref }, 200))
    .openapi(deployerRoutes.status, async (c) => c.json(await deployer.status(), 200));
  return http.service((line) => log(`deployer ${line}`)).route("/", routes).fetch;
};
