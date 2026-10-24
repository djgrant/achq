import type { Instance, InstanceAt, InstanceSettings, ProjectSummary, ServiceAt, ServiceDomain, Workspace } from "./types.ts";

export type Data = Record<string, any>;

export type Operation<Vars, Result> = {
  document: string;
  pick: (data: Data) => Result;
  /** Never set: it carries the variables' type to whoever calls it. */
  vars?: Vars;
};

export const op = <Vars, Result>(document: string, pick: (data: Data) => Result): Operation<Vars, Result> => ({ document, pick });

export type Edges<T> = { edges: { node: T }[] };

export const nodes = <T>(connection: Edges<T>) => connection.edges.map((e) => e.node);

const nothing = () => undefined;

export type RawProject = {
  id: string;
  name: string;
  environments: Edges<{ id: string; name: string }>;
  services: Edges<{ id: string; name: string }>;
  volumes: Edges<{ id: string; volumeInstances: Edges<{ serviceId: string | null; mountPath: string }> }>;
};

export const OPERATIONS = {
  apiToken: op<Record<string, never>, Workspace[]>(`query { apiToken { workspaces { id name } } }`, (d) => d.apiToken.workspaces),
  projects: op<{ workspaceId?: string }, ProjectSummary[]>(
    `query ($workspaceId: String) { projects(workspaceId: $workspaceId) { edges { node { id name } } } }`,
    (d) => nodes(d.projects),
  ),
  project: op<{ id: string }, RawProject>(
    `query ($id: String!) {
      project(id: $id) {
        id name
        environments { edges { node { id name } } }
        services { edges { node { id name } } }
        volumes { edges { node { id volumeInstances { edges { node { serviceId mountPath } } } } } }
      }
    }`,
    (d) => d.project,
  ),
  projectCreate: op<{ input: { name: string; workspaceId: string } }, string>(
    `mutation ($input: ProjectCreateInput!) { projectCreate(input: $input) { id } }`,
    (d) => d.projectCreate.id,
  ),

  projectDelete: op<{ id: string }, void>(`mutation ($id: String!) { projectDelete(id: $id) }`, nothing),
  serviceCreate: op<{ input: { projectId: string; environmentId: string; name: string } }, string>(
    `mutation ($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }`,
    (d) => d.serviceCreate.id,
  ),
  serviceDelete: op<{ id: string; environmentId: string }, void>(
    `mutation ($id: String!, $environmentId: String!) { serviceDelete(id: $id, environmentId: $environmentId) }`,
    nothing,
  ),
  serviceInstance: op<InstanceAt, Instance>(
    `query ($environmentId: String!, $serviceId: String!) {
      serviceInstance(environmentId: $environmentId, serviceId: $serviceId) {
        source { image repo } dockerfilePath startCommand healthcheckPath sleepApplication
        latestDeployment { id status }
      }
    }`,
    (d) => d.serviceInstance,
  ),
  serviceInstanceUpdate: op<InstanceAt & { input: InstanceSettings }, void>(
    `mutation ($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
      serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
    }`,
    nothing,
  ),
  serviceConnect: op<{ id: string; input: { repo: string; branch: string } }, void>(
    `mutation ($id: String!, $input: ServiceConnectInput!) { serviceConnect(id: $id, input: $input) { id } }`,
    nothing,
  ),
  serviceInstanceAutoDeployStatus: op<ServiceAt, boolean>(
    `query ($projectId: String!, $environmentId: String!, $serviceId: String!) {
      serviceInstanceAutoDeployStatus(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) { enabled }
    }`,
    (d) => d.serviceInstanceAutoDeployStatus.enabled,
  ),
  serviceInstanceAutoDeployUpdate: op<{ input: ServiceAt & { enabled: boolean } }, void>(
    `mutation ($input: ServiceInstanceAutoDeployUpdateInput!) { serviceInstanceAutoDeployUpdate(input: $input) { enabled } }`,
    nothing,
  ),
  /** Builds and deploys the head of the connected branch. */
  serviceInstanceDeploy: op<InstanceAt, void>(
    `mutation ($serviceId: String!, $environmentId: String!) {
      serviceInstanceDeploy(serviceId: $serviceId, environmentId: $environmentId, latestCommit: true)
    }`,
    nothing,
  ),
  /** Deploys with the current settings and variables. */
  serviceInstanceDeployV2: op<InstanceAt, void>(
    `mutation ($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }`,
    nothing,
  ),

  variables: op<ServiceAt, Record<string, string>>(
    `query ($projectId: String!, $environmentId: String!, $serviceId: String!) {
      variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
    }`,
    (d) => d.variables,
  ),
  variableCollectionUpsert: op<{ input: ServiceAt & { variables: Record<string, string>; skipDeploys: boolean } }, void>(
    `mutation ($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`,
    nothing,
  ),

  variableDelete: op<{ input: ServiceAt & { name: string } }, void>(`mutation ($input: VariableDeleteInput!) { variableDelete(input: $input) }`, nothing),

  volumeCreate: op<{ input: ServiceAt & { mountPath: string } }, void>(`mutation ($input: VolumeCreateInput!) { volumeCreate(input: $input) { id } }`, nothing),
  volumeDelete: op<{ volumeId: string }, void>(`mutation ($volumeId: String!) { volumeDelete(volumeId: $volumeId) }`, nothing),

  domains: op<ServiceAt, ServiceDomain[]>(
    `query ($projectId: String!, $environmentId: String!, $serviceId: String!) {
      domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) { serviceDomains { id domain targetPort } }
    }`,
    (d) => d.domains.serviceDomains,
  ),
  serviceDomainCreate: op<{ input: InstanceAt & { targetPort: number } }, string>(
    `mutation ($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }`,
    (d) => d.serviceDomainCreate.domain,
  ),
  serviceDomainDelete: op<{ id: string }, void>(`mutation ($id: String!) { serviceDomainDelete(id: $id) }`, nothing),
  privateNetworks: op<{ environmentId: string }, string[]>(
    `query ($environmentId: String!) { privateNetworks(environmentId: $environmentId) { publicId } }`,
    (d) => d.privateNetworks.map((n: { publicId: string }) => n.publicId),
  ),
  privateNetworkEndpoint: op<InstanceAt & { privateNetworkId: string }, { publicId: string; dnsName: string } | null>(
    `query ($environmentId: String!, $privateNetworkId: String!, $serviceId: String!) {
      privateNetworkEndpoint(environmentId: $environmentId, privateNetworkId: $privateNetworkId, serviceId: $serviceId) { publicId dnsName }
    }`,
    (d) => d.privateNetworkEndpoint,
  ),
  privateNetworkEndpointRename: op<{ id: string; dnsName: string; privateNetworkId: string }, void>(
    `mutation ($id: String!, $dnsName: String!, $privateNetworkId: String!) {
      privateNetworkEndpointRename(id: $id, dnsName: $dnsName, privateNetworkId: $privateNetworkId)
    }`,
    nothing,
  ),
} satisfies Record<string, Operation<any, any>>;

/** The field an operation asks for, which is its key in OPERATIONS. */
export type RailwayField = keyof typeof OPERATIONS;

/** The first field a document asks for, as Railway (and its fake) see it. */
export const rootField = (document: string) => document.slice(document.indexOf("{") + 1).match(/^\s*(\w+)/)?.[1] ?? "";

export const isMutation = (document: string) => document.trimStart().startsWith("mutation");
