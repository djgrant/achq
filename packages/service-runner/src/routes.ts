import { runnerRoutes } from "@achq/core/routes/runner";
import { signedBy } from "@achq/core/signing";
import { serve, service } from "@achq/utils/routes";
import { Hono } from "hono";
import type { Runner } from "./features/runner.ts";

/**
 * The runner's app, as `@achq/core/routes/runner` declares it, and how it's
 * served. Every route but health takes only requests signed with the
 * container's secret.
 */
export const routes = (runner: Runner) => {
  const app = new Hono();
  app.use(signedBy(runner.secret, runner.now));
  serve(app, runnerRoutes.events, (c) => {
    // Handled after answering: the router waits for the response, and a run can take hours.
    runner.accept(c.req.valid("json"));
    return c.text("accepted", 202);
  });
  return { runner: app, fetch: service(runner.log).route("/", app).fetch };
};
