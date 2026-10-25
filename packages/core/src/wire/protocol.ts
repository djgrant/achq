import { json, type Json } from "@achq/utils/json";
import { z } from "zod";
import type { BrowserAction } from "../model/browser-action.ts";
import type { ChannelCredential, PolicyCredential } from "../model/credentials.ts";
import type { ChannelEvent, DeployerEvent } from "../model/events.ts";
import { policyData, selectorData } from "../model/manifest.ts";
import { repoName } from "../model/repos.ts";
import type { ThreadRef } from "../model/threads.ts";

/*
 * Each schema has one of two roles. A request schema is a `z.object`: it
 * strips unknown keys, so an older server ignores a newer CLI's extra field.
 * A wire or stored schema reads what another version of achq wrote: it's a
 * `z.looseObject`, so unknown keys pass through, with no limits, and a field
 * added to it is optional. The manifest has both roles: `@achq/core/manifest`.
 */

/** A channel event, as the router forwards and keeps it: only what it routes by is checked, as each channel shapes the rest. */
export const channelEvent = z.custom<ChannelEvent>((value) => json.isPlainObject(value) && typeof value.delivery === "string" && typeof value.type === "string");

const repoEvent = z.object({
  delivery: z.string(),
  type: z.string(),
  deploy: z.array(z.string()),
  uninstall: z.array(z.string()),
}) satisfies z.ZodType<DeployerEvent>;

/** A deployer event as the router keeps it until the deployer answers: a stored schema, so loose. */
export const deployerEvent = z.looseObject(repoEvent.shape) satisfies z.ZodType<DeployerEvent>;

/** What the router forwards to the deployer: which repos to deploy and uninstall. */
export const DeployerEnvelope = z.object({ event: repoEvent });
export type DeployerEnvelope = z.infer<typeof DeployerEnvelope>;

export const ContainerEnvelope = z.object({
  event: channelEvent,
  /** The commit whose `.achq/` config the router was given, so the container runs the same one. */
  commit: z.string(),
  /** The container's workspace the router routed the thread to: the one that claimed it, or the first that matches it now. */
  workspace: z.string(),
});
export type ContainerEnvelope = z.infer<typeof ContainerEnvelope>;

/** What the deployer posts and the router keeps: a stored schema, so loose. */
export const RouterRepoConfig = z.looseObject({
  repo: z.string(),
  /** The commit whose `.achq/` config this is. Forwarded with events so containers run the same config. */
  commit: z.string(),
  containers: z.array(z.looseObject({ name: z.string(), url: z.string(), policies: z.array(policyData) })),
  workspaces: z.array(z.looseObject({ name: z.string(), container: z.string(), threads: selectorData, branch: z.string(), base: z.string() })),
  triggers: z.array(z.looseObject({ name: z.string(), event: selectorData })),
});
export type RouterRepoConfig = z.infer<typeof RouterRepoConfig>;

const repoSegment = z.string().regex(new RegExp(`^${repoName.segment}$`));

/** A route's `{owner}/{name}`, in characters that can't escape a path or a directory: a repo that doesn't fit is refused with a 400. */
export const RepoParams = z.object({ owner: repoSegment, name: repoSegment });
export type RepoParams = z.infer<typeof RepoParams>;

/** A repo, on the infra's code host: what the router's public endpoints for the repo CLI take, with your code host token as the bearer. */
export const RepoRequest = z.object({ repo: z.string() });
export type RepoRequest = z.infer<typeof RepoRequest>;

export const WakeRequest = RepoRequest.extend({ container: z.string() });
export type WakeRequest = z.infer<typeof WakeRequest>;

/** Whether `source`, e.g. a GitHub App's slug, is installed on the repo: `POST /installation`. */
export const InstallationRequest = RepoRequest.extend({ source: z.string() });
export type InstallationRequest = z.infer<typeof InstallationRequest>;

/** Who a container says it is. Its signature proves it. */
export const CredentialsRequest = z.object({ repo: z.string(), container: z.string() });
export type CredentialsRequest = z.infer<typeof CredentialsRequest>;


export const MintRequest = z.object({ repo: z.string(), policies: z.array(policyData) });
export type MintRequest = z.infer<typeof MintRequest>;

export const ValidateRequest = MintRequest;
export type ValidateRequest = MintRequest;

export const SyncRequest = z.object({
  /** Deletes containers no installed repo's manifest has. */
  prune: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  /** Syncs as if no repo were installed, so each is uninstalled and, with `prune`, every container deleted: `achq infra down`. */
  empty: z.boolean().optional(),
  /** The containers, as `<repo>/<name>`, you were shown it prunes: if it would prune any other, it fails before it uninstalls or prunes anything. */
  expect: z.array(z.string()).optional(),
});
export type SyncRequest = z.infer<typeof SyncRequest>;

/** A thread's session, as the runner's `sessions` command prints them (wire/commands.ts) (a JSON array, most recently run first) for `achq container resume`. `thread` is e.g. the issue number. */
export const SessionSummary = z.looseObject({ id: z.string(), thread: z.string(), agent: z.string(), workspace: z.string(), lastRun: z.string() });
export type SessionSummary = z.infer<typeof SessionSummary>;

// ── Responses and stored values: what another version of achq wrote ──

const jsonValue: z.ZodType<Json> = z.json();
const threadRef = z.looseObject({ channel: z.string(), id: z.string() }) satisfies z.ZodType<ThreadRef>;
const browserAction = z.looseObject({ url: z.string(), what: z.string() }) satisfies z.ZodType<BrowserAction>;
const credential = { value: z.string(), expiresAt: z.string(), scope: z.record(z.string(), jsonValue) };
const policyCredential = z.looseObject({ ...credential, provider: z.string() }) satisfies z.ZodType<PolicyCredential>;
const channelCredential = z.looseObject({ ...credential, channel: z.string() }) satisfies z.ZodType<ChannelCredential>;

/** What `POST /admin/mint` answers: one or more credentials per policy provider, covering the policies asked for. */
export const MintResponse = z.array(policyCredential);
export type MintResponse = z.infer<typeof MintResponse>;

/** What `POST /admin/validate` answers: what's wrong with the policies, for the repo, if anything. */
export const ValidateResponse = z.looseObject({ problems: z.array(z.string()) });
export type ValidateResponse = z.infer<typeof ValidateResponse>;

/** A delivery some target never answered, as `GET /admin/failed` lists it. `target` is a container's `<repo>/<name>`, or `deployer`. */
export const FailedDelivery = z.looseObject({
  delivery: z.string(),
  type: z.string(),
  repo: z.string().optional(),
  thread: threadRef.optional(),
  targets: z.array(z.looseObject({ target: z.string(), error: z.string() })),
});
export type FailedDelivery = z.infer<typeof FailedDelivery>;

/** What `POST /admin/failed/replay` did: deliveries back in the inbox, and ones with nowhere left to go. */
export const ReplayResult = z.looseObject({ replayed: z.array(z.string()), dropped: z.array(z.string()) });
export type ReplayResult = z.infer<typeof ReplayResult>;

export const CredentialsResponse = z.looseObject({
  /** For the agent: one or more per policy provider, covering the container's policies. */
  credentials: z.array(policyCredential),
  /** For the runner only, never the agent: one per channel source the container's workspaces use. */
  channels: z.array(channelCredential),
});
export type CredentialsResponse = z.infer<typeof CredentialsResponse>;

export const InstalledRepo = z.looseObject({ repo: z.string() });
export type InstalledRepo = z.infer<typeof InstalledRepo>;

/**
 * A source's installation on a repo, as the router's code host sees it: whether
 * it covers the repo, and the page where you change that, e.g. a GitHub App's
 * install page, or its installation's settings, where you choose its repos.
 */
export const RepoInstallation = z.looseObject({ installed: z.boolean(), url: z.string() });
export type RepoInstallation = z.infer<typeof RepoInstallation>;

/** What a source (e.g. a GitHub App) is set up to send and allow, for checks. */
export const SourceSettings = z.looseObject({ channel: z.string(), source: z.string(), events: z.array(z.string()), permissions: z.record(z.string(), z.string()) });
export type SourceSettings = z.infer<typeof SourceSettings>;

export const SyncResult = z.looseObject({
  deployed: z.array(z.string()),
  unchanged: z.array(z.string()),
  uninstalled: z.array(z.string()),
  pruned: z.array(z.string()),
  failed: z.array(z.looseObject({ repo: z.string(), error: z.string() })),
});
export type SyncResult = z.infer<typeof SyncResult>;

/** The achq commit the deployer runs: a new one reaches it some time after its Worker is deployed. */
export const DeployerVersion = z.looseObject({ ref: z.string() });
export type DeployerVersion = z.infer<typeof DeployerVersion>;

/** What `POST /sync` answers: the sync it started, which `GET /sync/<id>` reports on. */
export const SyncStarted = z.looseObject({ id: z.string() });
export type SyncStarted = z.infer<typeof SyncStarted>;

/**
 * A sync's progress: a failed one's error isn't shown, only logged. An
 * interrupted one stopped when its deployer did, and is started again. A
 * deployer older than `interrupted` answers 404 for a sync it lost instead.
 */
export const SyncStatus = z.discriminatedUnion("state", [
  z.looseObject({ state: z.literal("running") }),
  z.looseObject({ state: z.literal("done"), result: SyncResult }),
  z.looseObject({ state: z.literal("failed") }),
  z.looseObject({ state: z.literal("interrupted") }),
]);
export type SyncStatus = z.infer<typeof SyncStatus>;

export const DeployState = z.enum(["deployed", "failed", "uninstalled"]);
export type DeployState = z.infer<typeof DeployState>;

/** The deployer's record of a repo, as ACHQ_STATUS and `/admin/status` show it. */
export const DeployRecord = z.looseObject({
  repo: z.string(),
  state: DeployState,
  at: z.string(),
  error: z.string().optional(),
  commit: z.string().optional(),
  /** Per container: where to find it, from `ContainerProvider.locate`: its fields as strings. */
  containers: z.array(z.looseObject({ name: z.string(), location: z.object({}).catchall(z.string()) })).optional(),
  warnings: z.array(z.string()).optional(),
  /** What only you can do to fix a failed deploy, in your browser. `achq repo install` opens it, then deploys again. */
  action: browserAction.optional(),
});
export type DeployRecord = z.infer<typeof DeployRecord>;

/** The status the deployer writes where the repo's CLI reads it, e.g. GitHub's ACHQ_STATUS variable: its record, and the router's public URL. */
export const Status = DeployRecord.extend({ router: z.string() });
export type Status = z.infer<typeof Status>;
