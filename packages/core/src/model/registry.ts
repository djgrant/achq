import type { Resource } from "./resources.ts";

let registry: Resource[] = [];

/** Starts a fresh registry, for evaluating another config in the same process. */
export const resetRegistry = () => {
  registry = [];
};

export const register = (resource: Resource) => {
  registry.push(resource);
};

export const registered = () => [...registry];
