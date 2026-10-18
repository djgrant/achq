// Reads before it changes anything. Only `prepare` and `apply` make changes.
import type { InfraPlatform, ServiceDefinition } from "@achq/core";
import { type ProjectSnapshot, RailwayClient } from "../api.ts";
import { DEPLOY_POLL_ATTEMPTS, DEPLOY_POLL_INTERVAL_MS, RAILWAY_API, RAILWAY_ENV } from "../constants.ts";
import { hostServiceName, privateUrl } from "./names.ts";
import { planService, type Target } from "./plan.ts";
import { achqServiceSpec } from "./specs.ts";

export type RailwayInfraOptions = {
  /** The project's name. */
  project: string;
  token: string;
  workspaceId?: string;
  /** Railway's GraphQL endpoint, for tests. */
  endpoint?: string;
  sleep?: (ms: number) => Promise<void>;
};

const https = (domain: string | undefined) => (domain ? `https://${domain}` : undefined);

/** The infra's router and deployer as services in one Railway project. */
export const railwayInfra = (options: RailwayInfraOptions): InfraPlatform => {
  const railway = new RailwayClient(options.token, options.endpoint ?? RAILWAY_API);
  const sleep = options.sleep ?? Bun.sleep;
  // Filled in once the project is found or created. A dry run on a new project leaves it empty.
  const target: Target = {};

  const snapshot = async (): Promise<ProjectSnapshot | undefined> => {
    if (target.projectId) return railway.project(target.projectId);
    const found = await railway.projectByName(options.project, options.workspaceId);
    if (!found) return undefined;
    const project = await railway.project(found.id);
    Object.assign(target, { projectId: project.id, environmentId: project.environmentId });
    return project;
  };

  const service = async (name: string) => {
    const project = await snapshot();
    const found = project?.services.find((s) => s.name === hostServiceName(name));
    return project && found ? { project, id: found.id } : undefined;
  };

  return {
    async prepare(dryRun) {
      if (await snapshot()) return [];
      if (!dryRun) {
        const id = await railway.createProject(options.project, await railway.workspaceId(options.workspaceId));
        const project = await railway.project(id);
        Object.assign(target, { projectId: project.id, environmentId: project.environmentId });
      }
      return [{ op: "+", target: `railway project ${options.project}` }];
    },

    privateUrl: (name, port) => privateUrl(hostServiceName(name), port),

    async current(name) {
      const found = await service(name);
      if (!found) return undefined;
      const { project, id } = found;
      const [env, domains] = await Promise.all([railway.variables(project.id, project.environmentId, id), railway.domains(project.id, project.environmentId, id)]);
      return { env, publicUrl: https(domains[0]?.domain) };
    },

    async plan(definition: ServiceDefinition) {
      const spec = achqServiceSpec(definition);
      const plan = await planService(railway, target, spec, await snapshot());
      return {
        service: spec.name,
        changes: plan.changes,
        publicUrl: https(plan.current.domain),
        apply: async () => {
          const applied = await plan.apply();
          return { publicUrl: https(applied.domain), deployed: applied.deployed };
        },
      };
    },

    async waitForDeploy(name) {
      const found = await service(name);
      if (!found) throw new Error(`No ${hostServiceName(name)} to wait for`);
      for (let i = 0; i < DEPLOY_POLL_ATTEMPTS; i++) {
        const status = (await railway.instance(found.project.environmentId, found.id)).latestDeployment?.status;
        if (status === "SUCCESS") return;
        if (status === "FAILED" || status === "CRASHED") throw new Error(`${hostServiceName(name)}'s deploy ${status.toLowerCase()}; see its logs on Railway`);
        await sleep(DEPLOY_POLL_INTERVAL_MS);
      }
      throw new Error(`${hostServiceName(name)} hasn't deployed after five minutes`);
    },

    containerHostEnv: () => ({
      [RAILWAY_ENV.token]: options.token,
      [RAILWAY_ENV.projectId]: target.projectId ?? "(new)",
      [RAILWAY_ENV.environmentId]: target.environmentId ?? "(new)",
    }),
  };
};
