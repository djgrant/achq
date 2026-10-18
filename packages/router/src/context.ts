import type { AccessProvider, Channel, Installation, RouterRepoConfig, SourceSettings } from "@achq/core";
import { ATTEMPT_TIMEOUT_MS, DELAYS, GITHUB_API } from "./constants.ts";
import { createStore, type Store } from "./store.ts";
import type { Claims } from "./targets.ts";

export type RouterDeps = {
  channels: Channel[];
  providers: AccessProvider[];
  /** AGENT_WEBHOOK_KEY. */
  key: string;
  /** The router's volume. */
  dataDir: string;
  deployerUrl: string;
  installations: () => Promise<Installation[]>;
  sources: () => Promise<SourceSettings[]>;
  fetch?: typeof fetch;
  delays?: number[];
  /** How long one attempt to deliver an event or wake a service may take. */
  attemptTimeout?: number;
  now?: () => number;
  /** For `/wake`'s permission check. */
  githubApi?: string;
  log?: (line: string) => void;
};

/** The router's settings, with defaults filled in, and its state. */
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
  githubApi: deps.githubApi ?? GITHUB_API,
  log: deps.log ?? console.log,
  store: createStore(deps.dataDir),
  repos: new Map(),
  claims: new Map(),
  inFlight: new Map(),
});

export const configOf = (ctx: RouterContext, repo: string | undefined) => (repo ? ctx.repos.get(repo.toLowerCase()) : undefined);
