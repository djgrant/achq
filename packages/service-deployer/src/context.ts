import type { CodeHostProvider, ContainerProvider, FileLimits, Stores } from "@achq/core";
import type { RouterAdmin } from "@achq/core/clients/router";
import { async } from "@achq/utils/async";
import { type Evaluate, evaluateConfig } from "./features/config/evaluate.ts";
import { createStore } from "./store.ts";

export const DEFAULT_FILE_LIMITS: FileLimits = { maxFiles: 200, maxBytes: 1024 * 1024 };

/** What `main.ts` reads from its environment. */
export type DeployerEnv = {
  containerEnv: Record<string, string>;
  /** AGENT_WEBHOOK_KEY, for each container's secret. */
  key: string;
  routerUrl: string;
  /** The router's public URL, for ACHQ_STATUS. */
  routerPublicUrl: string;
  /** The achq commit it runs. */
  ref: string;
  /** The code host owners whose repos it deploys. */
  owners: string[];
  /** The agent runtimes the infra declares, by id: an agent on any other isn't deployed. */
  runtimes: string[];
};

export type DeployerDeps = {
  containerProvider: ContainerProvider;
  /** The router, at its private URL. */
  router: RouterAdmin;
  /** Where the repos it deploys live. */
  codeHost: CodeHostProvider;
  /** Where it keeps its records: its container provider's store. */
  stores: Stores;
  evaluate?: Evaluate;
  now?: () => Date;
  fileLimits?: FileLimits;
  log?: (line: string) => void;
};

/** Opens its store. */
export const createContext = async (env: DeployerEnv, { stores, ...deps }: DeployerDeps) => {
  const log = deps.log ?? ((line: string) => console.log(line));
  return {
    ...deps,
    env,
    store: await createStore(stores, log),
    evaluate: deps.evaluate ?? ((files) => evaluateConfig(files)),
    now: deps.now ?? (() => new Date()),
    log,
    /** Lowercased. */
    owners: new Set(env.owners.map((o) => o.toLowerCase())),
    fileLimits: deps.fileLimits ?? DEFAULT_FILE_LIMITS,
    /** One deploy or uninstall per repo at a time. */
    perRepo: async.keyedQueue(),
    /** Deliveries being handled, so a concurrent duplicate is turned away. */
    inFlight: new Set<string>(),
  };
};

export type DeployerContext = Awaited<ReturnType<typeof createContext>>;
