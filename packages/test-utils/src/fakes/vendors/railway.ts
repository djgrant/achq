import { isMutation, type RailwayField, rootField } from "@achq/utils/railway";

type FakeService = {
  id: string;
  name: string;
  settings: Record<string, unknown>;
  source: { image: string | null; repo: string | null };
  variables: Record<string, string>;
  domains: { id: string; domain: string; targetPort: number | null }[];
  endpoint?: { publicId: string; dnsName: string };
  deployments: { id: string; status: string }[];
  autoDeploy: boolean;
  branch?: string;
};

type FakeProject = {
  id: string;
  name: string;
  environmentId: string;
  services: FakeService[];
  volumes: { id: string; serviceId: string; mountPath: string }[];
};

export type FakeRailway = {
  url: string;
  projects: FakeProject[];
  mutations: string[];
  queries: string[];
  /** Repos Railway's GitHub App can't see: connecting a service to one fails as Railway's does. */
  unseenRepos: Set<string>;
  project(name: string): FakeProject | undefined;
  service(name: string): FakeService | undefined;
  stop(): void;
};

export const startFakeRailway = (seed: { workspaces?: string[] } = {}): FakeRailway => {
  let next = 1;
  const id = (prefix: string) => `${prefix}-${next++}`;
  const projects: FakeProject[] = [];
  const mutations: string[] = [];
  const queries: string[] = [];
  const unseenRepos = new Set<string>();
  const workspaces = (seed.workspaces ?? ["ws"]).map((w) => ({ id: w, name: w }));

  const findService = (serviceId: string) => {
    for (const p of projects) {
      const s = p.services.find((x) => x.id === serviceId);
      if (s) return { project: p, service: s };
    }
    throw new Error(`Service ${serviceId} not found`);
  };
  const deploy = (s: FakeService) => {
    s.deployments.unshift({ id: id("dep"), status: "SUCCESS" });
    // Railway gives a service its private hostname from its name on its first deploy.
    s.endpoint ??= { publicId: id("pne"), dnsName: s.name };
  };

  // Each returns whole objects whatever fields the query names: @achq/utils/railway only reads the fields it asks for.
  const handlers: Record<RailwayField, (v: any) => unknown> = {
    apiToken: () => ({ workspaces }),
    projects: () => ({ edges: projects.map((p) => ({ node: { id: p.id, name: p.name } })) }),
    projectCreate: ({ input }) => {
      const p: FakeProject = { id: id("proj"), name: input.name, environmentId: id("env"), services: [], volumes: [] };
      projects.push(p);
      return { id: p.id };
    },
    projectDelete: ({ id: projectId }) => {
      const at = projects.findIndex((x) => x.id === projectId);
      if (at < 0) throw new Error("Project not found");
      projects.splice(at, 1);
      return true;
    },
    project: ({ id: projectId }) => {
      const p = projects.find((x) => x.id === projectId);
      if (!p) throw new Error("Project not found");
      return {
        id: p.id,
        name: p.name,
        environments: { edges: [{ node: { id: p.environmentId, name: "production" } }] },
        services: { edges: p.services.map((s) => ({ node: { id: s.id, name: s.name } })) },
        volumes: { edges: p.volumes.map((v) => ({ node: { id: v.id, volumeInstances: { edges: [{ node: { serviceId: v.serviceId, mountPath: v.mountPath } }] } } })) },
      };
    },
    serviceCreate: ({ input }) => {
      const p = projects.find((x) => x.id === input.projectId)!;
      const s: FakeService = { id: id("svc"), name: input.name, settings: {}, source: { image: null, repo: null }, variables: {}, domains: [], deployments: [], autoDeploy: false };
      p.services.push(s);
      return { id: s.id };
    },
    serviceDelete: ({ id: serviceId }) => {
      const { project } = findService(serviceId);
      project.services = project.services.filter((s) => s.id !== serviceId);
      // Like Railway, the volume outlives the service unless deleted.
      return true;
    },
    serviceInstance: ({ serviceId }) => {
      const { service: s } = findService(serviceId);
      return { ...s.settings, source: s.source, latestDeployment: s.deployments[0] ?? null };
    },
    serviceInstanceUpdate: ({ serviceId, input }) => {
      const { service: s } = findService(serviceId);
      const { source, ...rest } = input;
      if (source) s.source = { ...s.source, ...source };
      Object.assign(s.settings, rest);
      return true;
    },
    serviceConnect: ({ id: serviceId, input }) => {
      if (unseenRepos.has(input.repo)) throw new Error("User does not have access to the repo");
      const { service: s } = findService(serviceId);
      s.source = { image: null, repo: input.repo };
      s.branch = input.branch;
      s.autoDeploy = true;
      deploy(s);
      return { id: s.id };
    },
    serviceInstanceAutoDeployStatus: ({ serviceId }) => ({ enabled: findService(serviceId).service.autoDeploy }),
    serviceInstanceAutoDeployUpdate: ({ input }) => {
      const { service: s } = findService(input.serviceId);
      s.autoDeploy = input.enabled;
      return { enabled: s.autoDeploy };
    },
    serviceInstanceDeploy: ({ serviceId }) => (deploy(findService(serviceId).service), true),
    serviceInstanceDeployV2: ({ serviceId }) => (deploy(findService(serviceId).service), id("dep")),
    variables: ({ serviceId }) => ({ ...findService(serviceId).service.variables }),
    variableCollectionUpsert: ({ input }) => {
      Object.assign(findService(input.serviceId).service.variables, input.variables);
      return true;
    },
    variableDelete: ({ input }) => {
      delete findService(input.serviceId).service.variables[input.name];
      return true;
    },
    volumeCreate: ({ input }) => {
      const p = projects.find((x) => x.id === input.projectId)!;
      const v = { id: id("vol"), serviceId: input.serviceId, mountPath: input.mountPath };
      p.volumes.push(v);
      return { id: v.id };
    },
    volumeDelete: ({ volumeId }) => {
      for (const p of projects) p.volumes = p.volumes.filter((v) => v.id !== volumeId);
      return true;
    },
    domains: ({ serviceId }) => ({ serviceDomains: findService(serviceId).service.domains }),
    serviceDomainCreate: ({ input }) => {
      const { service: s } = findService(input.serviceId);
      const d = { id: id("dom"), domain: `${s.name}-production.up.railway.app`, targetPort: input.targetPort ?? null };
      s.domains.push(d);
      return { domain: d.domain };
    },
    serviceDomainDelete: ({ id: domainId }) => {
      for (const p of projects) for (const s of p.services) s.domains = s.domains.filter((d) => d.id !== domainId);
      return true;
    },
    privateNetworks: () => [{ publicId: "pn" }],
    privateNetworkEndpoint: ({ serviceId }) => findService(serviceId).service.endpoint ?? null,
    privateNetworkEndpointRename: ({ id: endpointId, dnsName }) => {
      for (const p of projects) for (const s of p.services) if (s.endpoint && s.endpoint.publicId === endpointId) s.endpoint.dnsName = dnsName;
      return true;
    },
  };

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { query, variables } = (await req.json()) as { query: string; variables: Record<string, unknown> };
      const field = rootField(query);
      const handler = handlers[field as RailwayField];
      if (!handler) return Response.json({ errors: [{ message: `Fake Railway doesn't know ${field}` }] });
      (isMutation(query) ? mutations : queries).push(field);
      try {
        return Response.json({ data: { [field]: handler(variables ?? {}) } });
      } catch (e) {
        return Response.json({ errors: [{ message: (e as Error).message }] });
      }
    },
  });

  return {
    url: `http://localhost:${server.port}/graphql/v2`,
    projects,
    mutations,
    queries,
    unseenRepos,
    project: (name) => projects.find((p) => p.name === name),
    service: (name) => projects.flatMap((p) => p.services).find((s) => s.name === name),
    stop: () => server.stop(true),
  };
};
