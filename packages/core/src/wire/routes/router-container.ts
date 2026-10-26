// The router's route for containers, on the port the public can't reach, signed with each container's secret.
import { defineRoute, route } from "@achq/utils/routes";
import { CredentialsRequest, CredentialsResponse } from "../protocol.ts";

/** The body names the container, and its signature proves it's that container. */
export const credentials = defineRoute({
  method: "post",
  path: "/credentials",
  body: CredentialsRequest,
  responses: {
    200: route.json(CredentialsResponse),
    400: route.text("bad request"),
    401: route.text("bad signature"),
    404: route.text("no such container"),
  },
});

export const routerContainerRoutes = { credentials };
