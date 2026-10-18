import { createHash } from "node:crypto";
import type { Provider } from "@achq/reconcile";
import type { RailwayClient } from "../../api.ts";
import { DEPLOYED } from "../../constants.ts";
import type { Place } from "./project.ts";

export type DeploymentParams = { place: Place; serviceId: string; fingerprint: string };

/** An image service, deployed with the config its fingerprint was made from. A new fingerprint is a new deploy. */
export const deployment = (railway: RailwayClient): Provider<DeploymentParams, { fingerprint: string }> => ({
  schema: { fingerprint: { kind: "key" } },
  read: async ({ place, serviceId, fingerprint }) => {
    const [instance, vars] = await Promise.all([
      railway.instance(place.environmentId, serviceId),
      railway.variables(place.projectId, place.environmentId, serviceId, { unrendered: true }),
    ]);
    return instance.latestDeployment && vars[DEPLOYED] === fingerprint ? { fingerprint } : undefined;
  },
  create: async ({ place, serviceId, fingerprint }) => {
    await railway.deployImage(place.environmentId, serviceId);
    // Recorded once the deploy has started, so an interrupted run deploys next time.
    await railway.setVariables(place.projectId, place.environmentId, serviceId, { [DEPLOYED]: fingerprint });
    return { fingerprint };
  },
});

const stable = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]))
      : value;

/** A hash of what a deploy runs with. Secrets go in as digests, since variables only refer to them. */
export const fingerprint = (config: unknown) => createHash("sha256").update(JSON.stringify(stable(config))).digest("hex").slice(0, 16);
