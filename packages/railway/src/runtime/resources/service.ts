import type { Provider } from "@achq/reconcile";
import type { InstanceSettings, RailwayClient } from "../../api.ts";
import type { Place } from "./project.ts";

/** The instance settings achq manages. A setting left undefined isn't managed. */
export type ServiceSettings = { image?: string; dockerfilePath?: string; startCommand?: string; healthcheckPath?: string; sleepApplication?: boolean };

export type ServiceParams = ServiceSettings & { place: Place; name: string };
export type Service = ServiceSettings & { id: string; name: string };

const settingsOf = (p: ServiceSettings): ServiceSettings =>
  Object.fromEntries(Object.entries({ image: p.image, dockerfilePath: p.dockerfilePath, startCommand: p.startCommand, healthcheckPath: p.healthcheckPath, sleepApplication: p.sleepApplication }).filter(([, v]) => v !== undefined));

const instanceSettings = ({ image, ...rest }: ServiceSettings): InstanceSettings => ({ ...rest, ...(image !== undefined && { source: { image } }) });

export const service = (railway: RailwayClient): Provider<ServiceParams, Service> => ({
  schema: {
    name: { kind: "key" },
    image: { kind: "param" },
    dockerfilePath: { kind: "param" },
    startCommand: { kind: "param" },
    healthcheckPath: { kind: "param" },
    sleepApplication: { kind: "param" },
  },
  read: async ({ place, name }) => {
    const found = (await railway.project(place.projectId)).services.find((s) => s.name === name);
    if (!found) return undefined;
    const i = await railway.instance(place.environmentId, found.id);
    return {
      id: found.id,
      name,
      image: i.source?.image ?? undefined,
      dockerfilePath: i.dockerfilePath ?? undefined,
      startCommand: i.startCommand ?? undefined,
      healthcheckPath: i.healthcheckPath ?? undefined,
      sleepApplication: i.sleepApplication ?? undefined,
    };
  },
  create: async (p) => {
    const id = await railway.createService(p.place.projectId, p.place.environmentId, p.name);
    await railway.updateInstance(p.place.environmentId, id, instanceSettings(settingsOf(p)));
    return { ...settingsOf(p), id, name: p.name };
  },
  update: async (p, current) => {
    await railway.updateInstance(p.place.environmentId, current.id, instanceSettings(settingsOf(p)));
    return { ...current, ...settingsOf(p) };
  },
});
