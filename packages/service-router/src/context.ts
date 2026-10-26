import { type ChannelProvider, type CodeHostProvider, type PolicyProvider, repoName, type RouterRepoConfig, type Stores } from "@achq/core";
import { type Claims, createStore } from "./store.ts";

/** Milliseconds between attempts while a sleeping service wakes: about five minutes in all. */
const DELAYS = [2, 4, 8, 15, 30, 30, 30, 30, 60, 60].map((s) => s * 1000);

const ATTEMPT_TIMEOUT_MS = 30_000;

/** What `main.ts` reads from its environment. */
export type RouterEnv = {
  /** AGENT_WEBHOOK_KEY. */
  key: string;
  deployerUrl: string;
};

export type RouterDeps = {
  /** Each one's sources are what the deployer checks. */
  channelProviders: ChannelProvider[];
  policyProviders: PolicyProvider[];
  /** Where repos live: `/reach` checks push access with it, and the repos installed on it are what the deployer serves. */
  codeHost: CodeHostProvider;
  /** Where it keeps what outlives a crash: its container provider's store. */
  stores: Stores;
  fetch?: typeof fetch;
  delays?: number[];
  attemptTimeout?: number;
  now?: () => number;
  log?: (line: string) => void;
};

/**
 * Opens its store and loads config and claims from it, so no event is routed
 * against an empty config.
 */
export const createContext = async (env: RouterEnv, { stores, ...deps }: RouterDeps) => {
  const log = deps.log ?? ((line: string) => console.log(line));
  const store = await createStore(stores, log);
  /** Router config and claims, by `repoName.key`, written through to the store. */
  const repos = new Map<string, RouterRepoConfig>();
  const claims = new Map<string, Claims>();
  for (const config of await store.repos.all()) repos.set(repoName.key(config.repo), config);
  for (const name of await store.claims.list()) {
    const repoClaims = await store.claims.read(name);
    if (repoClaims) claims.set(name, repoClaims);
  }
  return {
    ...deps,
    env,
    fetch: deps.fetch ?? fetch,
    delays: deps.delays ?? DELAYS,
    attemptTimeout: deps.attemptTimeout ?? ATTEMPT_TIMEOUT_MS,
    now: deps.now ?? Date.now,
    log,
    /** What outlives a crash. */
    store,
    repos,
    claims,
    /** Deliveries being forwarded, so a duplicate isn't queued twice, and so tests can wait for them. */
    inFlight: new Map<string, Promise<void>>(),
  };
};

export type RouterContext = Awaited<ReturnType<typeof createContext>>;

export const configOf = (ctx: RouterContext, repo: string | undefined) => (repo ? ctx.repos.get(repoName.key(repo)) : undefined);

/** None for an event that names no repo. */
export const claimsOf = (ctx: RouterContext, repo: string | undefined) => (repo ? ctx.claims.get(repoName.key(repo)) : undefined) ?? {};
