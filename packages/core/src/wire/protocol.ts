// The HTTP contract between the router, the deployer, containers and the CLI.
//
// Signing (see secrets.ts `signedHeaders` / `verifySigned`):
//   admin      adminSecret(AGENT_WEBHOOK_KEY)                 router ⇄ deployer, infra CLI → router
//   container  containerSecret(AGENT_WEBHOOK_KEY, repo, name) router ⇄ container
//
// Router, public port (ROUTER_PUBLIC_PORT):
//   GET  /                         health
//   POST /webhook                  channel deliveries (each channel verifies its own)
//   POST /wake                     WakeRequest, `authorization: Bearer <token>` from someone who can push to the repo, on its host
//   *    /admin/...                as on the private port, admin-signed, for the infra CLI
//
// Router, private port (ROUTER_PRIVATE_PORT):
//   POST /credentials              CredentialsRequest → CredentialsResponse     container-signed
//   POST /claims                   ClaimRequest → 204                           container-signed
//   PUT  /admin/repos/<owner>/<repo>   RouterRepoConfig → 204                   admin
//   DELETE /admin/repos/<owner>/<repo> → 204                                    admin
//   GET  /admin/repos              → RouterRepoConfig[]                         admin
//   POST /admin/mint               MintRequest → AccessCredential[]             admin (the deployer's own access)
//   POST /admin/validate           ValidateRequest → { problems: string[] }     admin
//   GET  /admin/installations      → Installation[]                             admin
//   GET  /admin/sources            → SourceSettings[]                           admin
//   POST /admin/sync               SyncRequest → SyncResult                     admin, forwarded to the deployer (wakes it)
//   GET  /admin/status             → DeployRecord[]                             admin, forwarded to the deployer
//
// Deployer (DEPLOYER_PORT, private):
//   GET  /                         health
//   POST /events                   DeployerEnvelope → 202                       admin   (installation and push events)
//   POST /sync                     SyncRequest → SyncResult                     admin
//   GET  /status                   → DeployRecord[]                             admin
//
// Container (CONTAINER_PORT, private):
//   GET  /                         health
//   POST /events                   ContainerEnvelope → 202                      container-signed
import type { RepoManifest } from "../resources/repo-manifest.ts";
import type { PolicyData, SelectorData } from "../resources/config.ts";
import type { AccessCredential } from "../contracts/access.ts";
import type { ChannelCredential, ChannelEvent, ThreadRef } from "../contracts/channel.ts";

/** What the router forwards to the deployer: install and config events, which name the `CodeHost` they're about. */
export type DeployerEnvelope = { event: Extract<ChannelEvent, { host: string }> };

export type ContainerEnvelope = {
  event: ChannelEvent;
  /** The commit whose `.achq/` config the router was given, so the container runs the same one. */
  commit: string;
};

/** What the deployer tells the router about a deployed repo. Plain data. */
export type RouterRepoConfig = {
  /** The `CodeHost` the repo is on. */
  host: string;
  repo: string;
  /** The commit whose `.achq/` config this is. Forwarded with events so containers run the same config. */
  commit: string;
  containers: { name: string; url: string; policies: PolicyData[] }[];
  workspaces: RepoManifest["workspaces"];
  triggers: { name: string; event: SelectorData }[];
};

export type WakeRequest = { host: string; repo: string; container: string };

export type CredentialsRequest = { repo: string; container: string };
export type CredentialsResponse = {
  /** For the agent: one or more per access provider, covering the container's policies. */
  credentials: AccessCredential[];
  /** For the runner only, never the agent: one per channel source the container's workspaces use. */
  channels: ChannelCredential[];
};

export type ClaimRequest = { repo: string; container: string; workspace: string; thread: ThreadRef };

export type MintRequest = { repo: string; policies: PolicyData[] };
export type ValidateRequest = { repo: string; policies: PolicyData[] };

/** A repo a channel's source is installed on, and the `CodeHost` the repo is on. */
export type Installation = { channel: string; source: string; repo: string; host: string };

/** What a source (e.g. a GitHub App) is set up to send and allow, for checks. */
export type SourceSettings = { channel: string; source: string; events: string[]; permissions: Record<string, string> };

export type SyncRequest = { prune?: boolean; dryRun?: boolean };
export type SyncResult = { deployed: string[]; unchanged: string[]; uninstalled: string[]; pruned: string[]; failed: { repo: string; error: string }[] };

export type DeployState = "deployed" | "failed" | "uninstalled";

/** The deployer's record of a repo, as ACHQ_STATUS and `/admin/status` show it. */
export type DeployRecord = {
  /** The `CodeHost` the repo is on, and the source that installed it there. */
  host: string;
  repo: string;
  source: string;
  state: DeployState;
  at: string;
  error?: string;
  commit?: string;
  /** Per container: where to find it, from `ContainerHost.locate`. */
  containers?: { name: string; location: Record<string, string> }[];
  warnings?: string[];
};

/** One of a thread's sessions, as `achq-agent sessions <n>` prints them (a JSON array, most recently run first) for `achq resume`. */
export type SessionSummary = { id: string; agent: string; workspace: string; lastRun: string };

/** The ACHQ_STATUS repository variable's JSON. */
export type Status = DeployRecord & { router: string };
