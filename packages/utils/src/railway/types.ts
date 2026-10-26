import * as v from "valibot";
import type { Reads } from "../schema.ts";
import type * as model from "./model.ts";

export type { InstanceAt, InstanceSettings, ProjectAt, ServiceAt } from "./model.ts";

// What Railway answers, as achq reads it: loose, so fields achq doesn't read pass, and only those its documents ask for are declared.

export type Deployment = model.Deployment;
export const Deployment = v.looseObject({ id: v.string(), status: v.string() }) satisfies Reads<model.Deployment>;

/** Its settings, as InstanceSettings has them, and its latest deployment. */
export type Instance = model.Instance;
export const Instance = v.looseObject({
  source: v.nullish(v.looseObject({ image: v.nullish(v.string()), repo: v.nullish(v.string()) })),
  dockerfilePath: v.nullish(v.string()),
  startCommand: v.nullish(v.string()),
  healthcheckPath: v.nullish(v.string()),
  sleepApplication: v.nullish(v.boolean()),
  latestDeployment: v.nullable(Deployment),
}) satisfies Reads<model.Instance>;

export const DEPLOY_STATUS = { live: "SUCCESS", failed: "FAILED", crashed: "CRASHED" } as const;
export const FAILED_DEPLOY_STATUSES: readonly string[] = [DEPLOY_STATUS.failed, DEPLOY_STATUS.crashed];

export const Workspace = v.looseObject({ id: v.string(), name: v.string() });
export type Workspace = v.InferOutput<typeof Workspace>;
export const ProjectSummary = v.looseObject({ id: v.string(), name: v.string() });
export type ProjectSummary = v.InferOutput<typeof ProjectSummary>;
export const ServiceSummary = v.looseObject({ id: v.string(), name: v.string() });
export type ServiceSummary = v.InferOutput<typeof ServiceSummary>;

/** A volume as mounted on one service. A volume mounted on several appears once for each. */
export type AttachedVolume = { id: string; serviceId: string; mountPath: string };

export type ProjectSnapshot = {
  id: string;
  name: string;
  /** The environment it deploys to unless told otherwise: production, or else its first. */
  environmentId: string;
  services: ServiceSummary[];
  volumes: AttachedVolume[];
};

export const ServiceDomain = v.looseObject({ id: v.string(), domain: v.string(), targetPort: v.nullable(v.number()) }) satisfies Reads<model.ServiceDomain>;
export type ServiceDomain = model.ServiceDomain;

/** A service's private hostname, `<dnsName>.railway.internal`, and what's needed to rename it. */
export type PrivateEndpoint = { id: string; dnsName: string; privateNetworkId: string };
