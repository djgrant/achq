import { type ChannelProvider, type CodeHostProvider, type PolicyProvider, repoName, type RouterRepoConfig, type Stores } from "@achq/core";
import { ATTEMPT_TIMEOUT_MS, DELAYS } from "./constants.ts";
import type { Claims, FailedEntry, InboxEntry } from "./deliveries.ts";

export type RouterDeps = {
  /** Each one's sources are what the deployer checks. */
  channelProviders: ChannelProvider[];
  policyProviders: PolicyProvider[];
  /** Where repos live, by code host id: `/wake` checks push access with them, and the repos each has installed are what the deployer serves. */
  codeHostProviders: Record<string, CodeHostProvider>;
  /** AGENT_WEBHOOK_KEY. */
  key: string;
  /** Where it keeps what outlives a crash: its container provider's store. */
  stores: Stores;
  deployerUrl: string;
  fetch?: typeof fetch;
  delays?: number[];
  attemptTimeout?: number;
  now?: () => number;
  log?: (line: string) => void;
};

export const createContext = (deps: RouterDeps) => ({
  ...deps,
  fetch: deps.fetch ?? fetch,
  delays: deps.delays ?? DELAYS,
  attemptTimeout: deps.attemptTimeout ?? ATTEMPT_TIMEOUT_MS,
  now: deps.now ?? Date.now,
  log: deps.log ?? ((line: string) => console.log(line)),
  /** What outlives a crash. */
  store: {
    repos: deps.stores<RouterRepoConfig>("repos"),
    claims: deps.stores<Claims>("claims"),
    /** Accepted deliveries some target hasn't answered yet, by delivery ID. */
    inbox: deps.stores<InboxEntry>("inbox"),
    /** Deliveries some target never answered, by delivery ID. */
    failed: deps.stores<FailedEntry>("failed"),
  },
  /** Router config and claims, by `repoName.key`. Loaded on start, written through to the store. */
  repos: new Map<string, RouterRepoConfig>(),
  claims: new Map<string, Claims>(),
  /** Deliveries being forwarded, so a duplicate isn't queued twice, and so tests can wait for them. */
  inFlight: new Map<string, Promise<void>>(),
});

export type RouterContext = ReturnType<typeof createContext>;

export const configOf = (ctx: RouterContext, repo: string | undefined) => (repo ? ctx.repos.get(repoName.key(repo)) : undefined);

/** None for an event that names no repo. */
export const claimsOf = (ctx: RouterContext, repo: string | undefined): Claims => (repo ? ctx.claims.get(repoName.key(repo)) : undefined) ?? {};
