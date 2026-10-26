// The runner's route, for the router, on each repo container, signed with that container's secret.
import { defineRoute, route } from "@achq/utils/routes";
import { ContainerEnvelope } from "../protocol.ts";

/** A delivery the router forwards. Accepted before it's handled, as a run can take hours. */
export const events = defineRoute({
  method: "post",
  path: "/events",
  body: ContainerEnvelope,
  responses: { 202: route.text("accepted") },
});

export const runnerRoutes = { events };
