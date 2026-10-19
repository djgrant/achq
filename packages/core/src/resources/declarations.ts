import type { Resource } from "./resource.ts";

/** The resources the config being evaluated has declared so far. */
let declarations: Resource[] = [];

/** Starts afresh, for evaluating another config in the same process. */
export const resetDeclarations = () => {
  declarations = [];
};

export const declare = (resource: Resource) => {
  declarations.push(resource);
};

export const declared = () => [...declarations];
