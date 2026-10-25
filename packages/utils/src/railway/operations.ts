import { z } from "zod";
import { Instance, type InstanceAt, type InstanceSettings, ProjectSummary, type ServiceAt, ServiceDomain, Workspace } from "./types.ts";

export type Operation<Vars, Result> = {
  document: string;
  /** What Railway answers in the field the document asks for, which is the operation's name: parsed with it, and what it gives the caller. */
  result: z.ZodType<Result>;
  /** Never set: it carries the variables' type to whoever calls it. */
  vars?: Vars;
};

export const op = <Vars, Result>(document: string, result: z.ZodType<Result>): Operation<Vars, Result> => ({ document, result });

const edges = <T extends z.ZodType>(node: T) => z.looseObject({ edges: z.array(z.looseObject({ node })) });
export type Edges<T> = { edges: { node: T }[] };

export const nodes = <T>(connection: Edges<T>) => connection.edges.map((e) => e.node);

/** The answer of a mutation whose answer achq doesn't read. */
const nothing = z.unknown().transform((): void => undefined);

/** An object's one field. */
const field = <K extends string, T extends z.ZodType>(key: K, schema: T) => z.looseObject({ [key]: schema } as { [_ in K]: T }).transform((o) => o[key]);

const IdName = z.looseObject({ id: z.string(), name: z.string() });

export const RawProject = z.looseObject({
  id: z.string(),
  name: z.string(),
  environments: edges(IdName),
  services: edges(IdName),
  volumes: edges(z.looseObject({ id: z.string(), volumeInstances: edges(z.looseObject({ serviceId: z.string().nullable(), mountPath: z.string() })) })),
});
export type RawProject = z.infer<typeof RawProject>;

const PrivateNetworkEndpoint = z.looseObject({ publicId: z.string(), dnsName: z.string() }).nullable();

export const OPERATIONS = {
  apiToken: op<Record<string, never>, Workspace[]>(`query { apiToken { workspaces { id name } } }`, field("workspaces", z.array(Workspace))),
  projects: op<{ workspaceId?: string }, ProjectSummary[]>(
    `query ($workspaceId: String) { projects(workspaceId: $workspaceId) { edges { node { id name } } } }`,
    edges(ProjectSummary).transform(nodes),
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
    RawProject,
  ),
  projectCreate: op<{ input: { name: string; workspaceId: string } }, string>(
    `mutation ($input: ProjectCreateInput!) { projectCreate(input: $input) { id } }`,
    field("id", z.string()),
  ),

  projectDelete: op<{ id: string }, void>(`mutation ($id: String!) { projectDelete(id: $id) }`, nothing),
  serviceCreate: op<{ input: { projectId: string; environmentId: string; name: string } }, string>(
    `mutation ($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }`,
    field("id", z.string()),
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
    Instance,
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
    field("enabled", z.boolean()),
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
    z.record(z.string(), z.string()),
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
    field("serviceDomains", z.array(ServiceDomain)),
  ),
  serviceDomainCreate: op<{ input: InstanceAt & { targetPort: number } }, string>(
    `mutation ($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }`,
    field("domain", z.string()),
  ),
  serviceDomainDelete: op<{ id: string }, void>(`mutation ($id: String!) { serviceDomainDelete(id: $id) }`, nothing),
  privateNetworks: op<{ environmentId: string }, string[]>(
    `query ($environmentId: String!) { privateNetworks(environmentId: $environmentId) { publicId } }`,
    z.array(z.looseObject({ publicId: z.string() })).transform((networks) => networks.map((n) => n.publicId)),
  ),
  privateNetworkEndpoint: op<InstanceAt & { privateNetworkId: string }, { publicId: string; dnsName: string } | null>(
    `query ($environmentId: String!, $privateNetworkId: String!, $serviceId: String!) {
      privateNetworkEndpoint(environmentId: $environmentId, privateNetworkId: $privateNetworkId, serviceId: $serviceId) { publicId dnsName }
    }`,
    PrivateNetworkEndpoint,
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
