import type { Deployer, Router } from "../model/infra.ts";
import type { RepoPlan } from "../model/plan.ts";
import type { PolicyData, Resource } from "../model/resources.ts";
import type { AccessProvider } from "./access.ts";
import type { Channel } from "./channel.ts";
import type { Change } from "./platform.ts";
import type { Installation, SourceSettings, Status } from "./protocol.ts";
import type { RepoHost } from "./repos.ts";

type Env = Record<string, string | undefined>;

/** The router's part. Only the router holds the provider's secrets. */
export type ProviderRouter = {
  channel?: Channel;
  access?: AccessProvider;
  /** The repos each source is installed on: what the deployer serves. */
  installations(): Promise<Installation[]>;
  /** What each source is set up to send and allow, for the deployer's checks. */
  sources(): Promise<SourceSettings[]>;
};

/** The container's part. It holds no secrets: credentials come from the router. */
export type ProviderContainer = { channel?: Channel; access?: AccessProvider };

export type InfraStep = {
  /** The router's env as it is now. */
  current: Record<string, string>;
  /** Where the router hears deliveries. Unknown until it has a public URL. */
  hookUrl?: string;
  /** AGENT_WEBHOOK_KEY. */
  key: string;
  dryRun: boolean;
  /** Opens `url` in your browser to `what`, e.g. to create an App. */
  open(url: string, what: string): Promise<void>;
  /** Prints a resource's planned changes, or that it's up to date. */
  show(subject: string, changes: Change[]): void;
  log(line: string): void;
};

/** `achq up`'s part: the infra's resources that are this provider's, e.g. GitHub Apps. */
export interface ProviderInfra {
  /** This provider's resources among the infra's. Throws if they don't fit its router and deployer. */
  resources(all: Resource[], services: { router: Router; deployer: Deployer }): Resource[];
  /** The router variables this provider keeps, from the router's env as it is now. */
  routerEnv(current: Record<string, string>): Record<string, string>;
  /** Creates and updates its resources. Returns `routerEnv` with anything it created. */
  up(resources: Resource[], step: InfraStep): Promise<Record<string, string>>;
}

/** The repo commands' part, acting as you. */
export interface ProviderCli {
  /** The repo a git remote URL names, if it's this provider's. */
  repoOf(remote: string): string | undefined;
  /** Proves who you are to `RepoHost.canPush`, for `/wake`. */
  token(): string;
  /** The status the deployer last wrote, or undefined if it hasn't. */
  status(repo: string): Promise<Status | undefined>;
  /** Checks the source the config names can serve it, then installs it on the repo (unless it's a dry run). */
  install(repo: string, plan: RepoPlan, options: { dryRun: boolean; open(url: string): Promise<void>; log(line: string): void }): Promise<void>;
  /** Removes the repo from its source. Returns what to tell you. */
  uninstall(repo: string, plan: RepoPlan): Promise<string>;
  /** The latest commit on `branch` that touched any of `paths`. */
  lastCommit(repo: string, branch: string, paths: string[]): Promise<string>;
}

/**
 * Everything achq needs from a provider of channels, access and repos, e.g.
 * GitHub. Each side picks it by id and calls its own part. Its channel, access
 * provider and repo host share its id.
 */
export interface Provider {
  readonly id: string;
  /** The source a policy of this provider's goes through, e.g. a GitHub policy's App. */
  policySource(policy: PolicyData): string | undefined;
  /** From the router variables `infra.up` set, and AGENT_WEBHOOK_KEY. */
  router(env: Env, key: string): ProviderRouter;
  container(env: Env): ProviderContainer;
  /** For providers that host repos. */
  repos?(env: Env): RepoHost;
  infra?(env: Env): ProviderInfra;
  cli?(env: Env): ProviderCli;
  /** Variables only the router has. A container never hands them to an agent, in case they're set anyway. */
  readonly privateEnv: string[];
}
