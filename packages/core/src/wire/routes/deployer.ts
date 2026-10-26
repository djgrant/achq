// The deployer's routes, for the router, each signed with the admin secret. A sync runs in the
// background, as its builds can take longer than any hop keeps a request open: `sync` answers
// with its ID, and `syncStatus` with how it's going.
import { defineRoute, route } from "@achq/utils/routes";
import * as v from "valibot";
import { DeployerEnvelope, DeployerVersion, DeployRecord, ReachRequest, Shell, SyncRequest, SyncStarted, SyncStatus } from "../protocol.ts";

/** A delivery the router forwards. Answered once handled, so the router keeps it until it's done. */
export const events = defineRoute({
  method: "post",
  path: "/events",
  body: DeployerEnvelope,
  responses: { 202: route.empty("handled") },
});

export const sync = defineRoute({
  method: "post",
  path: "/sync",
  body: SyncRequest,
  responses: { 202: route.json(SyncStarted) },
});

/** One that stopped when its deployer did is interrupted. A failed one's error is only logged. */
export const syncStatus = defineRoute({
  method: "get",
  path: "/sync/{id}",
  params: v.object({ id: v.string() }),
  responses: { 200: route.json(SyncStatus), 404: route.text("no such sync") },
});

export const version = defineRoute({
  method: "get",
  path: "/version",
  responses: { 200: route.json(DeployerVersion) },
});

/** Every repo's record. */
export const status = defineRoute({
  method: "get",
  path: "/status",
  responses: { 200: route.json(v.array(DeployRecord)) },
});

/** For the router's `/reach`, once it's checked you can push to the repo: the command that opens a shell in a container it deployed. */
export const shell = defineRoute({
  method: "post",
  path: "/shell",
  body: ReachRequest,
  responses: { 200: route.json(Shell), 404: route.text("no such container") },
});

export const deployerRoutes = { events, sync, syncStatus, version, status, shell };
