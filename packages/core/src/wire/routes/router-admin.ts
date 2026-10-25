// The router's admin routes, for the deployer and the infra CLI, signed with the admin secret.
// Paths are relative to where the router mounts them, `/admin`, on both its ports.
import { route } from "@achq/utils/http";
import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import {
  DeployerVersion,
  DeployRecord,
  FailedDelivery,
  InstalledRepo,
  MintRequest,
  MintResponse,
  ReplayResult,
  RepoParams,
  RouterRepoConfig,
  SourceSettings,
  SyncRequest,
  SyncStarted,
  SyncStatus,
  ValidateRequest,
  ValidateResponse,
} from "../protocol.ts";

/** What a forwarded route answers when the deployer doesn't: it gave up waking it. A deployer's own refusal keeps its status and body. */
const unreachable = route.text("the deployer didn't answer");

export const listRepos = createRoute({
  method: "get",
  path: "/repos",
  responses: { 200: route.json(z.array(RouterRepoConfig)) },
});

export const putRepo = createRoute({
  method: "put",
  path: "/repos/{owner}/{name}",
  request: { params: RepoParams, body: route.body(RouterRepoConfig) },
  responses: { 204: route.empty("stored"), 400: route.text("a config for another repo than the path names") },
});

/** Claims are kept: reinstalling brings everything back as it was. */
export const deleteRepo = createRoute({
  method: "delete",
  path: "/repos/{owner}/{name}",
  request: { params: RepoParams },
  responses: { 204: route.empty("removed") },
});

export const mint = createRoute({
  method: "post",
  path: "/mint",
  request: { body: route.body(MintRequest) },
  responses: { 200: route.json(MintResponse) },
});

export const validate = createRoute({
  method: "post",
  path: "/validate",
  request: { body: route.body(ValidateRequest) },
  responses: { 200: route.json(ValidateResponse) },
});

export const installed = createRoute({
  method: "get",
  path: "/installed",
  responses: { 200: route.json(z.array(InstalledRepo)) },
});

export const sources = createRoute({
  method: "get",
  path: "/sources",
  responses: { 200: route.json(z.array(SourceSettings)) },
});

/** Forwarded to the deployer's: it can outlast a request, so `syncStatus` asks after it. */
export const sync = createRoute({
  method: "post",
  path: "/sync",
  request: { body: route.body(SyncRequest) },
  responses: { 202: route.json(SyncStarted), 504: unreachable },
});

/** Forwarded to the deployer's. */
export const syncStatus = createRoute({
  method: "get",
  path: "/sync/{id}",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: route.json(SyncStatus), 404: route.text("no such sync"), 504: unreachable },
});

/** Each repo's deploy, as the deployer recorded it. Forwarded to the deployer's. */
export const status = createRoute({
  method: "get",
  path: "/status",
  responses: { 200: route.json(z.array(DeployRecord)), 504: unreachable },
});

/** The achq commit the deployer runs: the deployer's `/version`. */
export const deployerVersion = createRoute({
  method: "get",
  path: "/deployer",
  responses: { 200: route.json(DeployerVersion), 504: unreachable },
});

export const failed = createRoute({
  method: "get",
  path: "/failed",
  responses: { 200: route.json(z.array(FailedDelivery)) },
});

export const replay = createRoute({
  method: "post",
  path: "/failed/replay",
  responses: { 200: route.json(ReplayResult) },
});

export const routerAdminRoutes = { listRepos, putRepo, deleteRepo, mint, validate, installed, sources, sync, syncStatus, status, deployerVersion, failed, replay };
