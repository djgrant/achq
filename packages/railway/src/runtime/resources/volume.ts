import type { Provider } from "@achq/reconcile";
import type { RailwayClient } from "../../api.ts";
import type { Place } from "./project.ts";

export type VolumeParams = { place: Place; serviceId: string; mountPath: string };

/** A volume mounted on a service. One at another path is a different volume, and is left alone. */
export const volume = (railway: RailwayClient): Provider<VolumeParams, { mountPath: string }> => ({
  schema: { serviceId: { kind: "key" }, mountPath: { kind: "key" } },
  read: async ({ place, serviceId, mountPath }) => {
    const found = (await railway.project(place.projectId)).volumes.some((v) => v.serviceId === serviceId && v.mountPath === mountPath);
    return found ? { mountPath } : undefined;
  },
  create: async ({ place, serviceId, mountPath }) => {
    await railway.createVolume(place.projectId, place.environmentId, serviceId, mountPath);
    return { mountPath };
  },
});
