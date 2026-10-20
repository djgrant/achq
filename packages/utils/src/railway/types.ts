// Railway's objects as achq reads them: only the fields it asks for.

/** Where a service is: its project and the environment it runs in. */
export type ProjectAt = { projectId: string; environmentId: string };
export type ServiceAt = ProjectAt & { serviceId: string };
/** A service in an environment: what its instance is addressed by. */
export type InstanceAt = { environmentId: string; serviceId: string };

/** What a service instance is configured with. Only the fields achq sets. */
export type InstanceSettings = {
  source?: { image?: string | null; repo?: string | null } | null;
  dockerfilePath?: string | null;
  startCommand?: string | null;
  healthcheckPath?: string | null;
  sleepApplication?: boolean | null;
};

export type Deployment = { id: string; status: string };

export type Instance = InstanceSettings & { latestDeployment: Deployment | null };

/** The deploy statuses achq tells apart: a deploy that went live, and the two ways one fails. */
export const DEPLOY_STATUS = { live: "SUCCESS", failed: "FAILED", crashed: "CRASHED" } as const;
export const FAILED_DEPLOY_STATUSES: readonly string[] = [DEPLOY_STATUS.failed, DEPLOY_STATUS.crashed];

export type Workspace = { id: string; name: string };
export type ProjectSummary = { id: string; name: string };
export type ServiceSummary = { id: string; name: string };

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

export type ServiceDomain = { id: string; domain: string; targetPort: number | null };

/** A service's private hostname, `<dnsName>.railway.internal`, and what's needed to rename it. */
export type PrivateEndpoint = { id: string; dnsName: string; privateNetworkId: string };
