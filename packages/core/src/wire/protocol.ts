import { json } from "@achq/utils/json";
import { z } from "zod";
import type { ChannelCredential, ChannelEvent, ThreadRef } from "../contracts/channel-provider.ts";
import type { BrowserAction } from "../contracts/browser-action.ts";
import type { PolicyCredential } from "../contracts/policy-provider.ts";
import type { PolicyData, SelectorData } from "../resources/config.ts";

// What its channel or policy provider interprets is checked only for what names it.
const policyData = z.custom<PolicyData>((value) => json.isPlainObject(value) && typeof value.provider === "string");
const selectorData = z.custom<SelectorData>((value) => json.isPlainObject(value) && typeof value.channel === "string" && typeof value.source === "string");
const channelEvent = z.custom<ChannelEvent>((value) => json.isPlainObject(value) && typeof value.delivery === "string" && typeof value.type === "string");

/** What the router forwards to the deployer: install and config events, which name the `CodeHostProvider` they're about. */
export const DeployerEnvelope = z.object({ event: channelEvent.refine((event): event is Extract<ChannelEvent, { host: string }> => typeof event.host === "string") });
export type DeployerEnvelope = z.infer<typeof DeployerEnvelope>;

export const ContainerEnvelope = z.object({
  event: channelEvent,
  /** The commit whose `.achq/` config the router was given, so the container runs the same one. */
  commit: z.string(),
  /** The container's workspace the router routed the thread to: the one that claimed it, or the first that matches it now. */
  workspace: z.string(),
});
export type ContainerEnvelope = z.infer<typeof ContainerEnvelope>;

export const RouterRepoConfig = z.object({
  /** The `CodeHostProvider` the repo is on. */
  host: z.string(),
  repo: z.string(),
  /** The commit whose `.achq/` config this is. Forwarded with events so containers run the same config. */
  commit: z.string(),
  containers: z.array(z.object({ name: z.string(), url: z.string(), policies: z.array(policyData) })),
  workspaces: z.array(z.object({ name: z.string(), container: z.string(), threads: selectorData, branch: z.string(), base: z.string() })),
  triggers: z.array(z.object({ name: z.string(), event: selectorData })),
});
export type RouterRepoConfig = z.infer<typeof RouterRepoConfig>;

/** A repo, on the `CodeHostProvider` `host`: what the router's public endpoints for the repo CLI take, with your code host token as the bearer. */
export const RepoRequest = z.object({ host: z.string(), repo: z.string() });
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

/** A thread's session, as `achq-agent sessions [n]` prints them (a JSON array, most recently run first) for `achq container resume`. `thread` is e.g. the issue number. */
export const SessionSummary = z.object({ id: z.string(), thread: z.string(), agent: z.string(), workspace: z.string(), lastRun: z.string() });
export type SessionSummary = z.infer<typeof SessionSummary>;

/** A delivery some target never answered, as `GET /admin/failed` lists it. `target` is a container's `<repo>/<name>`, or `deployer`. */
export type FailedDelivery = { delivery: string; type: string; repo?: string; thread?: ThreadRef; targets: { target: string; error: string }[] };

/** What `POST /admin/failed/replay` did: deliveries back in the inbox, and ones with nowhere left to go. */
export type ReplayResult = { replayed: string[]; dropped: string[] };

export type CredentialsResponse = {
  /** For the agent: one or more per policy provider, covering the container's policies. */
  credentials: PolicyCredential[];
  /** For the runner only, never the agent: one per channel source the container's workspaces use. */
  channels: ChannelCredential[];
};

export type InstalledRepo = { host: string; repo: string };

/**
 * A source's installation on a repo, as the router's code host sees it: whether
 * it covers the repo, and the page where you change that, e.g. a GitHub App's
 * install page, or its installation's settings, where you choose its repos.
 */
export type RepoInstallation = { installed: boolean; url: string };

/** What a source (e.g. a GitHub App) is set up to send and allow, for checks. */
export type SourceSettings = { channel: string; source: string; events: string[]; permissions: Record<string, string> };

export type SyncResult = { deployed: string[]; unchanged: string[]; uninstalled: string[]; pruned: string[]; failed: { repo: string; error: string }[] };

/** The achq commit the deployer runs: a new one reaches it some time after its Worker is deployed. */
export type DeployerVersion = { ref: string };

/** What `POST /sync` answers: the sync it started, which `GET /sync/<id>` reports on. */
export type SyncStarted = { id: string };

/** A sync's progress: a failed one's error isn't shown, only logged. */
export type SyncStatus = { state: "running" } | { state: "done"; result: SyncResult } | { state: "failed" };

export type DeployState = "deployed" | "failed" | "uninstalled";

/** The deployer's record of a repo, as ACHQ_STATUS and `/admin/status` show it. */
export type DeployRecord = {
  /** The `CodeHostProvider` the repo is on. */
  host: string;
  repo: string;
  state: DeployState;
  at: string;
  error?: string;
  commit?: string;
  /** Per container: where to find it, from `ContainerProvider.locate`. */
  containers?: { name: string; location: Record<string, string> }[];
  warnings?: string[];
  /** What only you can do to fix a failed deploy, in your browser. `achq repo install` opens it, then deploys again. */
  action?: BrowserAction;
};

/** The ACHQ_STATUS repository variable's JSON. */
export type Status = DeployRecord & { router: string };
