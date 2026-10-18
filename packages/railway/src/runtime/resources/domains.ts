import type { Provider } from "@achq/reconcile";
import type { RailwayClient } from "../../api.ts";
import type { Place } from "./project.ts";

/** `ports` in ascending order. */
export type DomainsParams = { place: Place; serviceId: string; ports: number[] };
export type Domains = { ports: (number | null)[]; domains: { id: string; domain: string; port: number | null }[] };

const byPort = (a: number | null, b: number | null) => (a ?? -1) - (b ?? -1);

const readDomains = async (railway: RailwayClient, { place, serviceId }: DomainsParams): Promise<Domains> => {
  const found = await railway.domains(place.projectId, place.environmentId, serviceId);
  return { ports: found.map((d) => d.targetPort).sort(byPort), domains: found.map((d) => ({ id: d.id, domain: d.domain, port: d.targetPort })) };
};

/** A service's public domains: exactly one for each port listed, so `ports: []` keeps it private. */
export const publicDomains = (railway: RailwayClient): Provider<DomainsParams, Domains> => ({
  schema: { ports: { kind: "param" } },
  read: async (params) => readDomains(railway, params),
  update: async (params, current) => {
    const kept = new Set<number>();
    for (const d of current.domains) {
      if (d.port !== null && params.ports.includes(d.port) && !kept.has(d.port)) kept.add(d.port);
      else await railway.deleteDomain(d.id);
    }
    for (const port of params.ports) if (!kept.has(port)) await railway.createDomain(params.place.environmentId, params.serviceId, port);
    return readDomains(railway, params);
  },
  // A new domain's name is Railway's to choose.
  predict: (params, current) =>
    params.ports.every((p) => current.domains.some((d) => d.port === p))
      ? { ports: params.ports, domains: current.domains.filter((d) => d.port !== null && params.ports.includes(d.port)) }
      : undefined,
});

export const domainFor = (domains: Domains, port: number) => domains.domains.find((d) => d.port === port)?.domain;
