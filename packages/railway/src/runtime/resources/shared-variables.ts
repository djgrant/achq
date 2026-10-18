import type { SecretStore } from "@achq/core";
import type { RailwayClient } from "../../api.ts";
import type { Place } from "./project.ts";

/**
 * Secrets kept as the environment's shared variables. `legacy` finds a secret
 * kept somewhere older, so that writing it moves it here.
 */
export const sharedVariables = (railway: RailwayClient, place: Place, legacy?: (name: string) => Promise<string | undefined>): SecretStore => ({
  ref: (name) => `\${{shared.${name}}}`,
  read: async (name) => {
    const shared = await railway.sharedVariables(place.projectId, place.environmentId);
    if (shared[name] !== undefined) return { value: shared[name], location: "store" };
    const old = await legacy?.(name);
    return old === undefined ? undefined : { value: old, location: "legacy" };
  },
  write: (name, value) => railway.setSharedVariables(place.projectId, place.environmentId, { [name]: value }),
});
