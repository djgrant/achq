import type { RepoManifest } from "../resources/repo-manifest.ts";
import type { PolicyData, SelectorData } from "../resources/config.ts";
import type { PolicyCredential } from "../contracts/policy-provider.ts";
import type { ChannelCredential, ChannelEvent, ThreadRef } from "../contracts/channel-provider.ts";

/** What the router forwards to the deployer: install and config events, which name the `CodeHostProvider` they're about. */
export type DeployerEnvelope = { event: Extract<ChannelEvent, { host: string }> };

export type ContainerEnvelope = {
  event: ChannelEvent;
  /** The commit whose `.achq/` config the router was given, so the container runs the same one. */
  commit: string;
};

export type RouterRepoConfig = {
  /** The `CodeHostProvider` the repo is on. */
  host: string;
  repo: string;
  /** The commit whose `.achq/` config this is. Forwarded with events so containers run the same config. */
  commit: string;
  containers: { name: string; url: string; policies: PolicyData[] }[];
  workspaces: RepoManifest["workspaces"];
  triggers: { name: string; event: SelectorData }[];
};

export type WakeRequest = { host: string; repo: string; container: string };

/** A delivery some target never answered, as `GET /admin/failed` lists it. `target` is a container's `<repo>/<name>`, or `deployer`. */
export type FailedDelivery = { delivery: string; type: string; repo?: string; thread?: ThreadRef; targets: { target: string; error: string }[] };

/** What `POST /admin/failed/replay` did: deliveries back in the inbox, and ones with nowhere left to go. */
export type ReplayResult = { replayed: string[]; dropped: string[] };

export type CredentialsRequest = { repo: string; container: string };
export type CredentialsResponse = {
  /** For the agent: one or more per policy provider, covering the container's policies. */
  credentials: PolicyCredential[];
  /** For the runner only, never the agent: one per channel source the container's workspaces use. */
  channels: ChannelCredential[];
};

export type ClaimRequest = { repo: string; container: string; workspace: string; thread: ThreadRef };

export type MintRequest = { repo: string; policies: PolicyData[] };
export type ValidateRequest = { repo: string; policies: PolicyData[] };

export type InstalledRepo = { host: string; repo: string };

/** What a source (e.g. a GitHub App) is set up to send and allow, for checks. */
export type SourceSettings = { channel: string; source: string; events: string[]; permissions: Record<string, string> };

export type SyncRequest = { prune?: boolean; dryRun?: boolean };
export type SyncResult = { deployed: string[]; unchanged: string[]; uninstalled: string[]; pruned: string[]; failed: { repo: string; error: string }[] };

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
};

/** A thread's session, as `achq-agent sessions [n]` prints them (a JSON array, most recently run first) for `achq container resume`. `thread` is e.g. the issue number. */
export type SessionSummary = { id: string; thread: string; agent: string; workspace: string; lastRun: string };

/** The ACHQ_STATUS repository variable's JSON. */
export type Status = DeployRecord & { router: string };
