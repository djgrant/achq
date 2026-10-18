// The HTTP contract between the router, the deployer, containers and the CLI.
//
// Signing (see secrets.ts `signedHeaders` / `verifySigned`):
//   admin      adminSecret(AGENT_WEBHOOK_KEY)                 router ⇄ deployer, infra CLI → router
//   container  containerSecret(AGENT_WEBHOOK_KEY, repo, name) router ⇄ container
//
// Router, public port (ROUTER_PUBLIC_PORT):
//   GET  /                         health
//   POST /webhook                  channel deliveries (each channel verifies its own)
//   POST /wake                     WakeRequest, `authorization: Bearer <GitHub user token>` with push access to the repo
//   *    /admin/...                as on the private port, admin-signed, for the infra CLI
//
// Router, private port (ROUTER_PRIVATE_PORT):
//   POST /credentials              CredentialsRequest → CredentialsResponse     container-signed
//   POST /claims                   ClaimRequest → 204                           container-signed
//   PUT  /admin/repos/<owner>/<repo>   RouterRepoConfig → 204                   admin
//   DELETE /admin/repos/<owner>/<repo> → 204                                    admin
//   GET  /admin/repos              → RouterRepoConfig[]                         admin
//   POST /admin/mint               MintRequest → Credential[]                   admin (the deployer's own access)
//   POST /admin/validate           ValidateRequest → { problems: string[] }     admin
//   GET  /admin/installations      → Installation[]                             admin
//   GET  /admin/sources            → SourceSettings[]                           admin
//   POST /admin/sync               SyncRequest → SyncResult                     admin, forwarded to the deployer (wakes it)
//   GET  /admin/status             → DeployRecord[]                             admin, forwarded to the deployer
//
// Deployer (DEPLOYER_PORT, private):
//   GET  /                         health
//   POST /events                   EventEnvelope → 202                          admin   (installation and push events)
//   POST /sync                     SyncRequest → SyncResult                     admin
//   GET  /status                   → DeployRecord[]                             admin
//
// Container (CONTAINER_PORT, private):
//   GET  /                         health
//   POST /events                   EventEnvelope → 202                          container-signed
import type { RepoPlan } from "../model/plan.ts";
import type { PolicyData, SelectorData } from "../model/resources.ts";
import type { ChannelEvent, Credential, ThreadRef } from "./channel.ts";

export type EventEnvelope = {
  event: ChannelEvent;
  /** For containers: the commit whose `.achq/` config the router was given, so the container runs the same one. */
  commit?: string;
};

/** What the deployer tells the router about a deployed repo. Plain data. */
export type RouterRepoConfig = {
  repo: string;
  /** The commit whose `.achq/` config this is. Forwarded with events so containers run the same config. */
  commit: string;
  containers: { name: string; url: string; policies: PolicyData[] }[];
  workspaces: RepoPlan["workspaces"];
  triggers: { name: string; event: SelectorData }[];
};

export type WakeRequest = { repo: string; container: string };

export type CredentialsRequest = { repo: string; container: string };
export type CredentialsResponse = {
  /** For the agent: one or more per provider, covering the container's policies. */
  credentials: Credential[];
  /** For the runner only, never the agent: one per channel source the container's workspaces use. */
  channels: Credential[];
};

export type ClaimRequest = { repo: string; container: string; workspace: string; thread: ThreadRef };

export type MintRequest = { repo: string; policies: PolicyData[] };
export type ValidateRequest = { repo: string; policies: PolicyData[] };

export type Installation = { provider: string; source: string; repo: string };

/** What a source (a GitHub App) is set up to send and allow, for checks. */
export type SourceSettings = { channel: string; source: string; events: string[]; permissions: Record<string, string> };

export type SyncRequest = { prune?: boolean; dryRun?: boolean };
export type SyncResult = { deployed: string[]; unchanged: string[]; uninstalled: string[]; pruned: string[]; failed: { repo: string; error: string }[] };

export type DeployState = "deployed" | "failed" | "uninstalled";

/** The deployer's record of a repo. ACHQ_STATUS holds it without `plan` and `tree`. */
export type DeployRecord = {
  repo: string;
  source: string;
  state: DeployState;
  at: string;
  error?: string;
  commit?: string;
  /** The `.achq` tree last deployed. */
  tree?: string;
  plan?: RepoPlan;
  /** Per container: where to find it, from `ContainerHost.locate`. */
  containers?: { name: string; location: Record<string, string> }[];
  warnings?: string[];
};

/** The ACHQ_STATUS repository variable's JSON. */
export type Status = Omit<DeployRecord, "plan" | "tree"> & { router?: string };
