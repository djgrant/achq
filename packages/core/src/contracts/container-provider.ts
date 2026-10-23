import type { Vars } from "@achq/utils/env";
import type { Implementation } from "./implementation.ts";

export type ContainerSpec = {
  /** The `CodeHostProvider` the repo is on. */
  host: string;
  repo: string;
  name: string;
  /** Dockerfile path in the repo, e.g. `.achq/Dockerfile`. */
  dockerfile: string;
  branch: string;
  /**
   * The variables achq defines. The provider adds its own: PORT, and DATA_DIR since it owns where the container's data outlives a restart.
   * The provider may read ACHQ_ROUTER_URL (to keep the container awake) and ACHQ_REPO / ACHQ_CONTAINER (to list containers); these match `repo` and `name`.
   */
  env: Record<string, string>;
};

export interface ContainerProvider {
  /**
   * Creates or updates the container, and what keeps its DATA_DIR across restarts and sleep. Doesn't build.
   * Returns the URL the router reaches it on: one only achq's services reach, which wakes it.
   */
  ensure(spec: ContainerSpec): Promise<{ url: string }>;
  /** Builds and deploys the container from the head of its branch. */
  deploy(repo: string, name: string): Promise<void>;
  list(): Promise<{ repo: string; name: string }[]>;
  /** Deletes the container and its data. Only `achq infra up --prune` and `achq infra down` call this. */
  remove(repo: string, name: string): Promise<void>;
  /** Where to find it, for the repo CLI (`ssh`, `resume`). Not secret. */
  locate(repo: string, name: string): Promise<Record<string, string>>;
}

/** A container at a location its provider's `locate` gave, for `achq container ssh` and `achq container resume`. */
export interface ContainerShell {
  /** Whether the location has what `open` and `run` need. */
  reachable(location: Record<string, string>): boolean;
  /** A shell in the container, interactive or running `command`. Returns the exit code. */
  open(location: Record<string, string>, command: string[]): Promise<number>;
  run(location: Record<string, string>, command: string[]): Promise<string>;
}

/** JSON values by name: one collection of what a service keeps. A write is durable once it resolves: a crash right after it loses nothing. */
export interface JsonStore<T> {
  read(name: string): Promise<T | undefined>;
  write(name: string, value: T): Promise<void>;
  /** Removing a missing name is fine. */
  remove(name: string): Promise<void>;
  /** Every stored name, sorted. */
  list(): Promise<string[]>;
  /** Every stored value, in name order. */
  all(): Promise<T[]>;
}

/** A service's durable storage: each of its collections, by name. */
export type Stores = <T>(collection: string) => JsonStore<T>;

/**
 * A container provider as the registry lists it: the `ContainerProvider` the
 * deployer creates, the shell the repo CLI opens, and the durable storage the
 * router and deployer keep what they own in when they run on it.
 */
export type ContainerProviderImplementation = Implementation<ContainerProvider> & {
  shell: ContainerShell;
  /**
   * One of the router's or deployer's collections, kept wherever this provider
   * makes a write durable once it resolves: the router writes each webhook it
   * accepts before answering it. `env` is the service's own environment, as its
   * container provider set it.
   */
  store<T>(env: Vars, collection: string): JsonStore<T>;
};
