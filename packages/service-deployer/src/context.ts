import type { ContainerHost, FileLimits, RepoHost } from "@achq/core";
import type { RouterClient } from "./clients/router.ts";
import { type Evaluate, evaluateConfig } from "./config/index.ts";
import { DEFAULT_FILE_LIMITS } from "./constants.ts";
import { createStore, type Store } from "./store.ts";

export type DeployerEnv = {
  /** What every container gets: the agent runtimes' variables. */
  containerEnv: Record<string, string>;
  /** Variables a container never hands to an agent: every implementation's. */
  privateEnv: string[];
  /** AGENT_WEBHOOK_KEY, for each container's secret. */
  key: string;
  routerUrl: string;
  /** The router's public URL, for ACHQ_STATUS. */
  routerPublicUrl: string;
  ref: string;
};

export type DeployerDeps = {
  containerHost: ContainerHost;
  router: RouterClient;
  /** The repo hosts, by id. */
  hosts: Record<string, RepoHost>;
  owners: string[];
  dataDir: string;
  evaluate?: Evaluate;
  now?: () => Date;
  env: DeployerEnv;
  fileLimits?: FileLimits;
  log?: (line: string) => void;
};

/** What deploys, uninstalls and syncs share: the deps with their defaults filled in, and the store. */
export type DeployerContext = Required<Omit<DeployerDeps, "owners">> & {
  /** Lowercased. */
  owners: Set<string>;
  store: Store;
};

export const deployerContext = (deps: DeployerDeps): DeployerContext => ({
  ...deps,
  store: createStore(deps.dataDir),
  evaluate: deps.evaluate ?? ((files) => evaluateConfig(files)),
  now: deps.now ?? (() => new Date()),
  log: deps.log ?? ((line: string) => console.log(line)),
  owners: new Set(deps.owners.map((o) => o.toLowerCase())),
  fileLimits: deps.fileLimits ?? DEFAULT_FILE_LIMITS,
});
