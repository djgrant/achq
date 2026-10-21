import { join } from "node:path";
import { type ChannelProvider, type CodeHostProvider, type PolicyProvider, repoName, type RouterRepoConfig } from "@achq/core";
import { JsonDirStore } from "@achq/utils/disk";
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
  dataDir: string;
  deployerUrl: string;
  fetch?: typeof fetch;
  delays?: number[];
  attemptTimeout?: number;
  now?: () => number;
  log?: (line: string) => void;
};

/** What's kept per repo is kept in a file named after it. */
export const repoFile = (repo: string) => repoName.key(repo).replace("/", "__");
export const repoFromFile = (name: string) => name.replace("__", "/");

export const createContext = (deps: RouterDeps) => ({
  ...deps,
  fetch: deps.fetch ?? fetch,
  delays: deps.delays ?? DELAYS,
  attemptTimeout: deps.attemptTimeout ?? ATTEMPT_TIMEOUT_MS,
  now: deps.now ?? Date.now,
  log: deps.log ?? ((line: string) => console.log(line)),
  /** The volume. */
  store: {
    repos: new JsonDirStore<RouterRepoConfig>(join(deps.dataDir, "repos")),
    claims: new JsonDirStore<Claims>(join(deps.dataDir, "claims")),
    /** Accepted deliveries some target hasn't answered yet, by delivery ID. */
    inbox: new JsonDirStore<InboxEntry>(join(deps.dataDir, "inbox")),
    /** Deliveries some target never answered, by delivery ID. */
    failed: new JsonDirStore<FailedEntry>(join(deps.dataDir, "failed")),
  },
  /** Router config and claims, by `repoName.key`. Loaded on start, written through to the volume. */
  repos: new Map<string, RouterRepoConfig>(),
  claims: new Map<string, Claims>(),
  /** Deliveries being forwarded, so a duplicate isn't queued twice, and so tests can wait for them. */
  inFlight: new Map<string, Promise<void>>(),
});

export type RouterContext = ReturnType<typeof createContext>;

export const configOf = (ctx: RouterContext, repo: string | undefined) => (repo ? ctx.repos.get(repoName.key(repo)) : undefined);

/** None for an event that names no repo. */
export const claimsOf = (ctx: RouterContext, repo: string | undefined): Claims => (repo ? ctx.claims.get(repoName.key(repo)) : undefined) ?? {};
