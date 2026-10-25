// The runner's route, for the router, on each repo container, signed with that container's secret.
import { route } from "@achq/utils/http";
import { createRoute } from "@hono/zod-openapi";
import { ContainerEnvelope } from "../protocol.ts";

/** A delivery the router forwards. Accepted before it's handled, as a run can take hours. */
export const events = createRoute({
  method: "post",
  path: "/events",
  request: { body: route.body(ContainerEnvelope) },
  responses: { 202: route.text("accepted") },
});

export const runnerRoutes = { events };
