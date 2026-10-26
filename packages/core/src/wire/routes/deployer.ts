// The deployer's routes, for the router, each signed with the admin secret. A sync runs in the
// background, as its builds can take longer than any hop keeps a request open: `sync` answers
// with its ID, and `syncStatus` with how it's going.
import { route } from "@achq/utils/http";
import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { DeployerEnvelope, DeployerVersion, DeployRecord, ReachRequest, Shell, SyncRequest, SyncStarted, SyncStatus } from "../protocol.ts";

/** A delivery the router forwards. Answered once handled, so the router keeps it until it's done. */
export const events = createRoute({
  method: "post",
  path: "/events",
  request: { body: route.body(DeployerEnvelope) },
  responses: { 202: route.empty("handled") },
});

export const sync = createRoute({
  method: "post",
  path: "/sync",
  request: { body: route.body(SyncRequest) },
  responses: { 202: route.json(SyncStarted) },
});

/** One that stopped when its deployer did is interrupted. A failed one's error is only logged. */
export const syncStatus = createRoute({
  method: "get",
  path: "/sync/{id}",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: route.json(SyncStatus), 404: route.text("no such sync") },
});

export const version = createRoute({
  method: "get",
  path: "/version",
  responses: { 200: route.json(DeployerVersion) },
});

/** Every repo's record. */
export const status = createRoute({
  method: "get",
  path: "/status",
  responses: { 200: route.json(z.array(DeployRecord)) },
});

/** For the router's `/reach`, once it's checked you can push to the repo: the command that opens a shell in a container it deployed. */
export const shell = createRoute({
  method: "post",
  path: "/shell",
  request: { body: route.body(ReachRequest) },
  responses: { 200: route.json(Shell), 404: route.text("no such container") },
});

export const deployerRoutes = { events, sync, syncStatus, version, status, shell };
