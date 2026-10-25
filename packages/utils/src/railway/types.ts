import { z } from "zod";

export type ProjectAt = { projectId: string; environmentId: string };
export type ServiceAt = ProjectAt & { serviceId: string };
export type InstanceAt = { environmentId: string; serviceId: string };

/** Only the fields achq sets. */
export type InstanceSettings = {
  source?: { image?: string | null; repo?: string | null } | null;
  dockerfilePath?: string | null;
  startCommand?: string | null;
  healthcheckPath?: string | null;
  sleepApplication?: boolean | null;
};

// What Railway answers, as achq reads it: loose, so fields achq doesn't read pass, and only those its documents ask for are declared.

export const Deployment = z.looseObject({ id: z.string(), status: z.string() });
export type Deployment = z.infer<typeof Deployment>;

/** Its settings, as InstanceSettings has them, and its latest deployment. */
export const Instance = z.looseObject({
  source: z.looseObject({ image: z.string().nullish(), repo: z.string().nullish() }).nullish(),
  dockerfilePath: z.string().nullish(),
  startCommand: z.string().nullish(),
  healthcheckPath: z.string().nullish(),
  sleepApplication: z.boolean().nullish(),
  latestDeployment: Deployment.nullable(),
});
export type Instance = z.infer<typeof Instance>;

export const DEPLOY_STATUS = { live: "SUCCESS", failed: "FAILED", crashed: "CRASHED" } as const;
export const FAILED_DEPLOY_STATUSES: readonly string[] = [DEPLOY_STATUS.failed, DEPLOY_STATUS.crashed];

export const Workspace = z.looseObject({ id: z.string(), name: z.string() });
export type Workspace = z.infer<typeof Workspace>;
export const ProjectSummary = z.looseObject({ id: z.string(), name: z.string() });
export type ProjectSummary = z.infer<typeof ProjectSummary>;
export const ServiceSummary = z.looseObject({ id: z.string(), name: z.string() });
export type ServiceSummary = z.infer<typeof ServiceSummary>;

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

export const ServiceDomain = z.looseObject({ id: z.string(), domain: z.string(), targetPort: z.number().nullable() });
export type ServiceDomain = z.infer<typeof ServiceDomain>;

/** A service's private hostname, `<dnsName>.railway.internal`, and what's needed to rename it. */
export type PrivateEndpoint = { id: string; dnsName: string; privateNetworkId: string };
