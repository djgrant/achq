// The router's admin routes, for the deployer and the infra CLI, signed with the admin secret.
// Paths are relative to where the router mounts them, `/admin`, on both its ports.
import { defineRoute, route } from "@achq/utils/routes";
import * as v from "valibot";
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

export const listRepos = defineRoute({
  method: "get",
  path: "/repos",
  responses: { 200: route.json(v.array(RouterRepoConfig)) },
});

export const putRepo = defineRoute({
  method: "put",
  path: "/repos/{owner}/{name}",
  params: RepoParams,
  body: RouterRepoConfig,
  responses: { 204: route.empty("stored"), 400: route.text("a config for another repo than the path names") },
});

/** Claims are kept: reinstalling brings everything back as it was. */
export const deleteRepo = defineRoute({
  method: "delete",
  path: "/repos/{owner}/{name}",
  params: RepoParams,
  responses: { 204: route.empty("removed") },
});

export const mint = defineRoute({
  method: "post",
  path: "/mint",
  body: MintRequest,
  responses: { 200: route.json(MintResponse) },
});

export const validate = defineRoute({
  method: "post",
  path: "/validate",
  body: ValidateRequest,
  responses: { 200: route.json(ValidateResponse) },
});

export const installed = defineRoute({
  method: "get",
  path: "/installed",
  responses: { 200: route.json(v.array(InstalledRepo)) },
});

export const sources = defineRoute({
  method: "get",
  path: "/sources",
  responses: { 200: route.json(v.array(SourceSettings)) },
});

/** Forwarded to the deployer's: it can outlast a request, so `syncStatus` asks after it. */
export const sync = defineRoute({
  method: "post",
  path: "/sync",
  body: SyncRequest,
  responses: { 202: route.json(SyncStarted), 504: unreachable },
});

/** Forwarded to the deployer's. */
export const syncStatus = defineRoute({
  method: "get",
  path: "/sync/{id}",
  params: v.object({ id: v.string() }),
  responses: { 200: route.json(SyncStatus), 404: route.text("no such sync"), 504: unreachable },
});

/** Each repo's deploy, as the deployer recorded it. Forwarded to the deployer's. */
export const status = defineRoute({
  method: "get",
  path: "/status",
  responses: { 200: route.json(v.array(DeployRecord)), 504: unreachable },
});

/** The achq commit the deployer runs: the deployer's `/version`. */
export const deployerVersion = defineRoute({
  method: "get",
  path: "/deployer",
  responses: { 200: route.json(DeployerVersion), 504: unreachable },
});

export const failed = defineRoute({
  method: "get",
  path: "/failed",
  responses: { 200: route.json(v.array(FailedDelivery)) },
});

export const replay = defineRoute({
  method: "post",
  path: "/failed/replay",
  responses: { 200: route.json(ReplayResult) },
});

export const routerAdminRoutes = { listRepos, putRepo, deleteRepo, mint, validate, installed, sources, sync, syncStatus, status, deployerVersion, failed, replay };
