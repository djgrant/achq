import { json } from "@achq/utils/json";
import { type Reads, schema } from "@achq/utils/schema";
import * as v from "valibot";
import type { BrowserAction } from "../model/browser-action.ts";
import type { ChannelCredential, PolicyCredential } from "../model/credentials.ts";
import type { ChannelEvent, DeployerEvent } from "../model/events.ts";
import { policyData, selectorData } from "../model/manifest.ts";
import { repoName } from "../model/repos.ts";
import type { ThreadRef } from "../model/threads.ts";
import type * as types from "./types.ts";

/*
 * Each schema has one of two roles. A request schema is a `v.object`: it
 * strips unknown keys, so an older server ignores a newer CLI's extra field.
 * A wire or stored schema reads what another version of achq wrote: it's a
 * `v.looseObject`, so unknown keys pass through, with no limits, and a field
 * added to it is optional. The manifest has both roles: `@achq/core/manifest`.
 */

/** A channel event, as the router forwards and keeps it: only what it routes by is checked, as each channel shapes the rest. */
export const channelEvent = v.custom<ChannelEvent>((value) => json.isPlainObject(value) && typeof value.delivery === "string" && typeof value.type === "string");

const repoEvent = v.object({
  delivery: v.string(),
  type: v.string(),
  deploy: v.array(v.string()),
  uninstall: v.array(v.string()),
}) satisfies Reads<DeployerEvent>;

/** A deployer event as the router keeps it until the deployer answers: a stored schema, so loose. */
export const deployerEvent = v.looseObject(repoEvent.entries) satisfies Reads<DeployerEvent>;

/** What the router forwards to the deployer: which repos to deploy and uninstall. */
export const DeployerEnvelope = v.object({ event: repoEvent });
export type DeployerEnvelope = v.InferOutput<typeof DeployerEnvelope>;

export const ContainerEnvelope = v.object({
  event: channelEvent,
  /** The commit whose `.achq/` config the router was given, so the container runs the same one. */
  commit: v.string(),
  /** The container's workspace the router routed the thread to: the one that claimed it, or the first that matches it now. */
  workspace: v.string(),
});
export type ContainerEnvelope = v.InferOutput<typeof ContainerEnvelope>;

/** What the deployer posts and the router keeps: a stored schema, so loose. */
export const RouterRepoConfig = v.looseObject({
  repo: v.string(),
  /** The commit whose `.achq/` config this is. Forwarded with events so containers run the same config. */
  commit: v.string(),
  containers: v.array(v.looseObject({ name: v.string(), url: v.string(), policies: v.array(policyData) })),
  workspaces: v.array(v.looseObject({ name: v.string(), container: v.string(), threads: selectorData, branch: v.string(), base: v.string() })),
  triggers: v.array(v.looseObject({ name: v.string(), event: selectorData })),
});
export type RouterRepoConfig = v.InferOutput<typeof RouterRepoConfig>;

const repoSegment = v.pipe(v.string(), v.regex(new RegExp(`^${repoName.segment}$`)));

/** A route's `{owner}/{name}`, in characters that can't escape a path or a directory: a repo that doesn't fit is refused with a 400. */
export const RepoParams = v.object({ owner: repoSegment, name: repoSegment });
export type RepoParams = v.InferOutput<typeof RepoParams>;

/** A repo, on the infra's code host: what the router's public endpoints for the repo CLI take, with your code host token as the bearer. */
export const RepoRequest = v.object({ repo: v.string() });
export type RepoRequest = v.InferOutput<typeof RepoRequest>;

/** A shell in one of the repo's containers: `POST /reach`, which wakes it, and the deployer's `POST /shell`. `tty` for an interactive one. */
export const ReachRequest = v.object({ ...RepoRequest.entries, container: v.string(), command: v.array(v.string()), tty: v.boolean() });
export type ReachRequest = v.InferOutput<typeof ReachRequest>;

export const Shell = v.object({
  argv: v.pipe(v.array(v.string()), v.minLength(1)),
  env: v.optional(v.record(v.string(), v.string())),
  requires: v.array(v.object({ binary: v.string(), install: v.string() })),
}) satisfies Reads<types.Shell>;
export type Shell = types.Shell;

/** Whether `source`, e.g. a GitHub App's slug, is installed on the repo: `POST /installation`. */
export const InstallationRequest = v.object({ ...RepoRequest.entries, source: v.string() });
export type InstallationRequest = v.InferOutput<typeof InstallationRequest>;

/** Who a container says it is. Its signature proves it. */
export const CredentialsRequest = v.object({ repo: v.string(), container: v.string() });
export type CredentialsRequest = v.InferOutput<typeof CredentialsRequest>;

export const MintRequest = v.object({ repo: v.string(), policies: v.array(policyData) });
export type MintRequest = v.InferOutput<typeof MintRequest>;

export const ValidateRequest = MintRequest;
export type ValidateRequest = MintRequest;

export const SyncRequest = v.object({
  /** Deletes containers no installed repo's manifest has. */
  prune: v.optional(v.boolean()),
  dryRun: v.optional(v.boolean()),
  /** Syncs as if no repo were installed, so each is uninstalled and, with `prune`, every container deleted: `achq infra down`. */
  empty: v.optional(v.boolean()),
  /** The containers, as `<repo>/<name>`, you were shown it prunes: if it would prune any other, it fails before it uninstalls or prunes anything. */
  expect: v.optional(v.array(v.string())),
});
export type SyncRequest = v.InferOutput<typeof SyncRequest>;

/** A thread's session, as the runner's `sessions` command prints them (wire/commands.ts) (a JSON array, most recently run first) for `achq container resume`. `thread` is e.g. the issue number. */
export const SessionSummary = v.looseObject({ id: v.string(), thread: v.string(), agent: v.string(), workspace: v.string(), lastRun: v.string() });
export type SessionSummary = v.InferOutput<typeof SessionSummary>;

// ── Responses and stored values: what another version of achq wrote ──

const threadRef = v.looseObject({ channel: v.string(), id: v.string() }) satisfies Reads<ThreadRef>;
const browserAction = v.looseObject({ url: v.string(), what: v.string() }) satisfies Reads<BrowserAction>;
const credential = { value: v.string(), expiresAt: v.string(), scope: v.record(v.string(), schema.json) };
const policyCredential = v.looseObject({ ...credential, provider: v.string() }) satisfies Reads<PolicyCredential>;
const channelCredential = v.looseObject({ ...credential, channel: v.string() }) satisfies Reads<ChannelCredential>;

/** What `POST /admin/mint` answers: one or more credentials per policy provider, covering the policies asked for. */
export const MintResponse = v.array(policyCredential);
export type MintResponse = v.InferOutput<typeof MintResponse>;

/** What `POST /admin/validate` answers: what's wrong with the policies, for the repo, if anything. */
export const ValidateResponse = v.looseObject({ problems: v.array(v.string()) });
export type ValidateResponse = v.InferOutput<typeof ValidateResponse>;

/** A delivery some target never answered, as `GET /admin/failed` lists it. `target` is a container's `<repo>/<name>`, or `deployer`. */
export const FailedDelivery = v.looseObject({
  delivery: v.string(),
  type: v.string(),
  repo: v.optional(v.string()),
  thread: v.optional(threadRef),
  targets: v.array(v.looseObject({ target: v.string(), error: v.string() })),
});
export type FailedDelivery = v.InferOutput<typeof FailedDelivery>;

/** What `POST /admin/failed/replay` did: deliveries back in the inbox, and ones with nowhere left to go. */
export const ReplayResult = v.looseObject({ replayed: v.array(v.string()), dropped: v.array(v.string()) });
export type ReplayResult = v.InferOutput<typeof ReplayResult>;

export const CredentialsResponse = v.looseObject({
  /** For the agent: one or more per policy provider, covering the container's policies. */
  credentials: v.array(policyCredential),
  /** For the runner only, never the agent: one per channel source the container's workspaces use. */
  channels: v.array(channelCredential),
});
export type CredentialsResponse = v.InferOutput<typeof CredentialsResponse>;

export const InstalledRepo = v.looseObject({ repo: v.string() }) satisfies Reads<types.InstalledRepo>;
export type InstalledRepo = types.InstalledRepo;

export const RepoInstallation = v.looseObject({ installed: v.boolean(), url: v.string() }) satisfies Reads<types.RepoInstallation>;
export type RepoInstallation = types.RepoInstallation;

export const SourceSettings = v.looseObject({ channel: v.string(), source: v.string(), events: v.array(v.string()), permissions: v.record(v.string(), v.string()) }) satisfies Reads<types.SourceSettings>;
export type SourceSettings = types.SourceSettings;

export const SyncResult = v.looseObject({
  deployed: v.array(v.string()),
  unchanged: v.array(v.string()),
  uninstalled: v.array(v.string()),
  pruned: v.array(v.string()),
  failed: v.array(v.looseObject({ repo: v.string(), error: v.string() })),
});
export type SyncResult = v.InferOutput<typeof SyncResult>;

/** A plugin, as the services are given it: an npm package at a version. */
export const PluginRef = v.object({ package: v.string(), version: v.string() });

/** What the deployer runs: its version and the plugins it loaded. A new deployer reaches it some time after its deploy. */
export const DeployerVersion = v.looseObject({ version: v.string(), plugins: v.array(PluginRef) });
export type DeployerVersion = v.InferOutput<typeof DeployerVersion>;

/** What `POST /sync` answers: the sync it started, which `GET /sync/<id>` reports on. */
export const SyncStarted = v.looseObject({ id: v.string() });
export type SyncStarted = v.InferOutput<typeof SyncStarted>;

/**
 * A sync's progress: a failed one's error isn't shown, only logged. An
 * interrupted one stopped when its deployer did, and is started again.
 */
export const SyncStatus = v.variant("state", [
  v.looseObject({ state: v.literal("running") }),
  v.looseObject({ state: v.literal("done"), result: SyncResult }),
  v.looseObject({ state: v.literal("failed") }),
  v.looseObject({ state: v.literal("interrupted") }),
]);
export type SyncStatus = v.InferOutput<typeof SyncStatus>;

export const DeployState = v.picklist(["deployed", "failed", "uninstalled"]) satisfies Reads<types.DeployState>;
export type DeployState = types.DeployState;

export const DeployRecord = v.looseObject({
  repo: v.string(),
  state: DeployState,
  at: v.string(),
  error: v.optional(v.string()),
  commit: v.optional(v.string()),
  /** The containers deployed, by name: the router's `/reach` opens a shell in one. */
  containers: v.optional(v.array(v.looseObject({ name: v.string() }))),
  warnings: v.optional(v.array(v.string())),
  /** What only you can do to fix a failed deploy, in your browser. `achq repo install` opens it, then deploys again. */
  action: v.optional(browserAction),
}) satisfies Reads<types.DeployRecord>;
export type DeployRecord = types.DeployRecord;

export const Status = v.looseObject({ ...DeployRecord.entries, router: v.string() }) satisfies Reads<types.Status>;
export type Status = types.Status;
