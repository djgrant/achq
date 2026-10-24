import type { Vars } from "@achq/utils/env";
import { ENV } from "../wire/constants.ts";
import type { RepoIdentity } from "./code-host-provider.ts";
import type { Implementation } from "./implementation.ts";

export type ContainerSpec = {
  repo: string;
  /** The repo as its host identifies it, for a provider whose builds connect to it. */
  identity: RepoIdentity;
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

/** A container, as `ContainerProvider.list` gives it. */
export type ContainerRef = { repo: string; name: string };

/** The container whose `ContainerSpec.env` these variables are, by its ACHQ_REPO and ACHQ_CONTAINER, or undefined if they aren't a container's. */
export const containerOf = (variables: Record<string, string>): ContainerRef | undefined => {
  const repo = variables[ENV.repo];
  const name = variables[ENV.container];
  return repo && name ? { repo, name } : undefined;
};

export interface ContainerProvider {
  /**
   * Creates or updates the container, and what keeps its DATA_DIR across restarts and sleep.
   * With `build`, then builds and deploys it from the head of its branch, and only then resolves.
   * Returns the URL the router reaches it on: one only achq's services reach, which wakes it.
   */
  ensure(spec: ContainerSpec, options: { build: boolean }): Promise<{ url: string }>;
  list(): Promise<ContainerRef[]>;
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

/** JSON values by name, any string: one collection of what a service keeps. A write is durable once it resolves: a crash right after it loses nothing. */
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
 * Moves each value in `store` to the name `rename` gives it, where that's a
 * new one: written there, then removed from the old. Run before anything else
 * uses the store, so a move a crash cut short is simply made again.
 *
 * For the one-time move off names stores were once given as file names
 * (`owner__name`); delete it once deployed infras have run it.
 */
export const renameStored = async <T>(store: JsonStore<T>, rename: (name: string, value: T) => string) => {
  for (const name of await store.list()) {
    const value = await store.read(name);
    if (value === undefined) continue;
    const renamed = rename(name, value);
    if (renamed === name) continue;
    await store.write(renamed, value);
    await store.remove(name);
  }
};

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
