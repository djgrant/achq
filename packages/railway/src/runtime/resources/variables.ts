import type { Provider } from "@achq/reconcile";
import type { RailwayClient } from "../../api.ts";
import type { Place } from "./project.ts";

export type VariablesParams = { place: Place; serviceId: string; values: Record<string, string> };

/**
 * A service's variables. Only those listed are managed; others on the service
 * are left alone. They're read unrendered, so a reference to a shared variable
 * compares as written.
 */
export const variables = (railway: RailwayClient): Provider<VariablesParams, { values: Record<string, string> }> => ({
  schema: { values: { kind: "param" } },
  read: async ({ place, serviceId }) => ({ values: await railway.variables(place.projectId, place.environmentId, serviceId, { unrendered: true }) }),
  update: async ({ place, serviceId, values }, current, changed) => {
    const set = Object.fromEntries(changed.flatMap((c) => c.entries ?? []).map((name) => [name, values[name]!]));
    await railway.setVariables(place.projectId, place.environmentId, serviceId, set);
    return { values: { ...current.values, ...set } };
  },
});
