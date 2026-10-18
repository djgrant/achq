import type { Provider } from "@achq/reconcile";
import type { RailwayClient } from "../../api.ts";
import type { Place } from "./project.ts";

export type AutoDeployParams = { place: Place; serviceId: string; enabled: boolean };

/** Whether Railway deploys every push to the service's branch. */
export const autoDeploy = (railway: RailwayClient): Provider<AutoDeployParams, { enabled: boolean }> => ({
  schema: { enabled: { kind: "param" } },
  // A service not yet connected to a repo may not answer, and doesn't deploy on push either.
  read: async ({ place, serviceId }) => ({ enabled: await railway.autoDeploy(place.projectId, place.environmentId, serviceId).catch(() => false) }),
  update: async ({ place, serviceId, enabled }) => {
    await railway.setAutoDeploy(place.projectId, place.environmentId, serviceId, enabled);
    return { enabled };
  },
});
