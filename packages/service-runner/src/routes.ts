import { runnerRoutes } from "@achq/core/routes/runner";
import { signedBy } from "@achq/core/signing";
import { service } from "@achq/utils/routes";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Runner } from "./features/runner.ts";

/**
 * The runner's app, as `@achq/core/routes/runner` declares it, and how it's
 * served. Every route but health takes only requests signed with the
 * container's secret.
 */
export const routes = (runner: Runner) => {
  const app = new OpenAPIHono();
  // On its own: chained, `use` returns a plain Hono, which has no `openapi`.
  app.use(signedBy(runner.secret, runner.now));
  app.openapi(runnerRoutes.events, (c) => {
    // Handled after answering: the router waits for the response, and a run can take hours.
    runner.accept(c.req.valid("json"));
    return c.text("accepted", 202);
  });
  return { runner: app, fetch: service(runner.log).route("/", app).fetch };
};
