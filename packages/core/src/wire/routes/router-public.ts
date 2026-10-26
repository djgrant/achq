// The router's public routes: channels' webhooks, and the repo CLI's, each answering only someone who can push to the repo.
import { route } from "@achq/utils/http";
import { createRoute } from "@hono/zod-openapi";
import { InstallationRequest, ReachRequest, RepoInstallation, RepoRequest, Shell } from "../protocol.ts";

/** How the repo CLI's routes refuse: no bearer token, a repo name that isn't one, or a token that can't push to it. */
const refusals = { 400: route.text("bad request"), 401: route.text("missing token"), 403: route.text("no push access") };

/** A channel's delivery: its body is the channel's own, checked by its signature, so it's read raw. */
export const webhook = createRoute({
  method: "post",
  path: "/webhook",
  responses: {
    200: route.text("ignored, or matching nothing"),
    202: route.text("accepted, or a duplicate"),
    400: route.text("bad delivery id"),
    401: route.text("bad signature"),
  },
});

/**
 * For `achq container ssh` and `resume`: wakes a container, then answers with
 * the command that opens a shell in it from your machine, which its deployer
 * computes with the container provider's credentials.
 */
export const reach = createRoute({
  method: "post",
  path: "/reach",
  request: { body: route.body(ReachRequest) },
  responses: { 200: route.json(Shell), ...refusals, 404: route.text("not deployed"), 504: route.text("it didn't wake, or the deployer didn't answer") },
});

/** For `achq repo install` and `uninstall`: whether the config's source is installed on the repo, and where you'd change that. */
export const installation = createRoute({
  method: "post",
  path: "/installation",
  request: { body: route.body(InstallationRequest) },
  responses: { 200: route.json(RepoInstallation), ...refusals, 404: route.text("unknown source") },
});

/** For `achq repo install`, once you've fixed what failed its deploy: deploys the repo again, as installing it does. */
export const deploy = createRoute({
  method: "post",
  path: "/deploy",
  request: { body: route.body(RepoRequest) },
  responses: { 202: route.text("accepted"), ...refusals },
});

export const routerPublicRoutes = { webhook, reach, installation, deploy };
