import { type ChannelProvider, type CodeHostProvider, type PolicyProvider, repoName, type RouterRepoConfig } from "@achq/core";
import { ATTEMPT_TIMEOUT_MS, DELAYS } from "./constants.ts";
import { createStore, type Store } from "./store.ts";
import type { Claims } from "./targets.ts";

export type RouterDeps = {
  /** Each one's sources are what the deployer checks. */
  channelProviders: ChannelProvider[];
  policyProviders: PolicyProvider[];
  /** Where repos live, by code host id: `/wake` checks push access with them, and the repos each has installed are what the deployer serves. */
  codeHostProviders: Record<string, CodeHostProvider>;
  /** AGENT_WEBHOOK_KEY. */
  key: string;
  dataDir: string;
  deployerUrl: string;
  fetch?: typeof fetch;
  delays?: number[];
  attemptTimeout?: number;
  now?: () => number;
  log?: (line: string) => void;
};

export type RouterContext = Required<Omit<RouterDeps, "dataDir">> & {
  store: Store;
  /** Router config and claims, by lowercased repo. Loaded on start, written through to the volume. */
  repos: Map<string, RouterRepoConfig>;
  claims: Map<string, Claims>;
  /** Deliveries being forwarded, so a duplicate isn't queued twice, and so tests can wait for them. */
  inFlight: Map<string, Promise<void>>;
};

export const createContext = (deps: RouterDeps): RouterContext => ({
  ...deps,
  fetch: deps.fetch ?? fetch,
  delays: deps.delays ?? DELAYS,
  attemptTimeout: deps.attemptTimeout ?? ATTEMPT_TIMEOUT_MS,
  now: deps.now ?? Date.now,
  log: deps.log ?? console.log,
  store: createStore(deps.dataDir),
  repos: new Map(),
  claims: new Map(),
  inFlight: new Map(),
});

export const configOf = (ctx: RouterContext, repo: string | undefined) => (repo ? ctx.repos.get(repoName.key(repo)) : undefined);

/** None for an event that names no repo. */
export const claimsOf = (ctx: RouterContext, repo: string | undefined): Claims => (repo ? ctx.claims.get(repoName.key(repo)) : undefined) ?? {};
