import type { Provider } from "@achq/reconcile";
import type { RailwayClient } from "../../api.ts";
import type { Place } from "./project.ts";

export type HostnameParams = { place: Place; serviceId: string; name: string };
export type Hostname = { name: string; endpoint?: { id: string; privateNetworkId: string } };

/**
 * A service's private hostname, `<name>.railway.internal`. Railway takes it
 * from the service's name on its first deploy, and keeps it if the service is
 * renamed.
 */
export const privateHostname = (railway: RailwayClient): Provider<HostnameParams, Hostname> => ({
  schema: { name: { kind: "param" } },
  read: async ({ place, serviceId, name }) => {
    const endpoint = await railway.privateEndpoint(place.environmentId, serviceId);
    // Before its first deploy a service has none, and it will be named after the service.
    return endpoint ? { name: endpoint.dnsName, endpoint } : { name };
  },
  update: async ({ name }, current) => {
    await railway.renamePrivateEndpoint(current.endpoint!.id, current.endpoint!.privateNetworkId, name);
    return { ...current, name };
  },
});
