// Railway's types as achq keeps them: plain, so plugins' resources, which keep them in their state, and their declarations need no zod.
// types.ts's schemas check what Railway answers against them.

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

export type Deployment = { id: string; status: string; [key: string]: unknown };

/** Its settings, as InstanceSettings has them, and its latest deployment. */
export type Instance = {
  source?: { image?: string | null; repo?: string | null; [key: string]: unknown } | null;
  dockerfilePath?: string | null;
  startCommand?: string | null;
  healthcheckPath?: string | null;
  sleepApplication?: boolean | null;
  latestDeployment: Deployment | null;
  [key: string]: unknown;
};

/** One of a service's domains, and the port it routes to. */
export type ServiceDomain = { id: string; domain: string; targetPort: number | null; [key: string]: unknown };
