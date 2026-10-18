// The fake Railway in `@achq/test-utils` answers every query and mutation here,
// so keep the two in step.

export const RAILWAY_API = "https://backboard.railway.com/graphql/v2";

/** What a service instance is configured with. Only the fields achq sets. */
export type InstanceSettings = {
  source?: { image?: string | null; repo?: string | null } | null;
  dockerfilePath?: string | null;
  startCommand?: string | null;
  healthcheckPath?: string | null;
  sleepApplication?: boolean | null;
};

export type Instance = InstanceSettings & { latestDeployment: { id: string; status: string } | null };

export type ProjectSnapshot = {
  id: string;
  name: string;
  environmentId: string;
  services: { id: string; name: string }[];
  volumes: { id: string; serviceId: string; mountPath: string }[];
};

type Edges<T> = { edges: { node: T }[] };

export class RailwayError extends Error {}

export class RailwayClient {
  constructor(
    private token: string,
    readonly endpoint = RAILWAY_API,
  ) {}

  async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    let json: { data?: T; errors?: { message: string }[] };
    try {
      json = JSON.parse(text);
    } catch {
      throw new RailwayError(`Railway: ${res.status} ${text.slice(0, 200)}`);
    }
    if (json.errors?.length || !json.data) throw new RailwayError(`Railway: ${json.errors?.map((e) => e.message).join("; ") ?? res.status}`);
    return json.data;
  }

  // ── Workspaces and projects ────────────────────────────────────────────────

  /** The token's only workspace, or `preferred`. */
  async workspaceId(preferred?: string) {
    if (preferred) return preferred;
    const { apiToken } = await this.gql<{ apiToken: { workspaces: { id: string; name: string }[] } }>(`query { apiToken { workspaces { id name } } }`);
    if (apiToken.workspaces.length === 1) return apiToken.workspaces[0].id;
    const list = apiToken.workspaces.map((w) => `${w.name}: ${w.id}`).join(", ");
    throw new RailwayError(`Set RAILWAY_WORKSPACE_ID to one of your Railway workspaces: ${list}`);
  }

  async projectByName(name: string, workspaceId?: string) {
    const { projects } = await this.gql<{ projects: Edges<{ id: string; name: string }> }>(
      `query ($workspaceId: String) { projects(workspaceId: $workspaceId) { edges { node { id name } } } }`,
      { workspaceId },
    );
    const found = projects.edges.map((e) => e.node).filter((p) => p.name === name);
    if (found.length > 1) throw new RailwayError(`Several Railway projects are named ${name}`);
    return found[0];
  }

  async createProject(name: string, workspaceId: string) {
    const { projectCreate } = await this.gql<{ projectCreate: { id: string } }>(
      `mutation ($input: ProjectCreateInput!) { projectCreate(input: $input) { id } }`,
      { input: { name, workspaceId } },
    );
    return projectCreate.id;
  }

  async project(id: string): Promise<ProjectSnapshot> {
    const { project } = await this.gql<{
      project: {
        id: string;
        name: string;
        environments: Edges<{ id: string; name: string }>;
        services: Edges<{ id: string; name: string }>;
        volumes: Edges<{ id: string; volumeInstances: Edges<{ serviceId: string | null; mountPath: string }> }>;
      };
    }>(
      `query ($id: String!) {
        project(id: $id) {
          id name
          environments { edges { node { id name } } }
          services { edges { node { id name } } }
          volumes { edges { node { id volumeInstances { edges { node { serviceId mountPath } } } } } }
        }
      }`,
      { id },
    );
    const environments = project.environments.edges.map((e) => e.node);
    const environment = environments.find((e) => e.name === "production") ?? environments[0];
    if (!environment) throw new RailwayError(`Railway project ${project.name} has no environment`);
    return {
      id: project.id,
      name: project.name,
      environmentId: environment.id,
      services: project.services.edges.map((e) => e.node),
      volumes: project.volumes.edges.flatMap((v) =>
        v.node.volumeInstances.edges.flatMap((i) => (i.node.serviceId ? [{ id: v.node.id, serviceId: i.node.serviceId, mountPath: i.node.mountPath }] : [])),
      ),
    };
  }

  // ── Services ───────────────────────────────────────────────────────────────

  async createService(projectId: string, environmentId: string, name: string) {
    const { serviceCreate } = await this.gql<{ serviceCreate: { id: string } }>(
      `mutation ($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }`,
      { input: { projectId, environmentId, name } },
    );
    return serviceCreate.id;
  }

  async deleteService(serviceId: string, environmentId: string) {
    await this.gql(`mutation ($id: String!, $environmentId: String!) { serviceDelete(id: $id, environmentId: $environmentId) }`, {
      id: serviceId,
      environmentId,
    });
  }

  async instance(environmentId: string, serviceId: string): Promise<Instance> {
    const { serviceInstance } = await this.gql<{ serviceInstance: Instance }>(
      `query ($environmentId: String!, $serviceId: String!) {
        serviceInstance(environmentId: $environmentId, serviceId: $serviceId) {
          source { image repo } dockerfilePath startCommand healthcheckPath sleepApplication
          latestDeployment { id status }
        }
      }`,
      { environmentId, serviceId },
    );
    return serviceInstance;
  }

  async updateInstance(environmentId: string, serviceId: string, input: InstanceSettings) {
    await this.gql(
      `mutation ($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
        serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
      }`,
      { serviceId, environmentId, input },
    );
  }

  /** Connects the service to a GitHub repo and branch. Railway starts a build from it. */
  async connect(serviceId: string, repo: string, branch: string) {
    await this.gql(`mutation ($id: String!, $input: ServiceConnectInput!) { serviceConnect(id: $id, input: $input) { id } }`, {
      id: serviceId,
      input: { repo, branch },
    });
  }

  /** Whether Railway deploys on every push to the connected branch. */
  async autoDeploy(projectId: string, environmentId: string, serviceId: string) {
    const { serviceInstanceAutoDeployStatus } = await this.gql<{ serviceInstanceAutoDeployStatus: { enabled: boolean } }>(
      `query ($projectId: String!, $environmentId: String!, $serviceId: String!) {
        serviceInstanceAutoDeployStatus(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) { enabled }
      }`,
      { projectId, environmentId, serviceId },
    );
    return serviceInstanceAutoDeployStatus.enabled;
  }

  async setAutoDeploy(projectId: string, environmentId: string, serviceId: string, enabled: boolean) {
    await this.gql(
      `mutation ($input: ServiceInstanceAutoDeployUpdateInput!) { serviceInstanceAutoDeployUpdate(input: $input) { enabled } }`,
      { input: { projectId, environmentId, serviceId, enabled } },
    );
  }

  /** Builds and deploys the head of the connected branch. */
  async deployLatestCommit(environmentId: string, serviceId: string) {
    await this.gql(
      `mutation ($serviceId: String!, $environmentId: String!) {
        serviceInstanceDeploy(serviceId: $serviceId, environmentId: $environmentId, latestCommit: true)
      }`,
      { serviceId, environmentId },
    );
  }

  /** Deploys an image service with its current settings and variables. */
  async deployImage(environmentId: string, serviceId: string) {
    await this.gql(`mutation ($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }`, {
      serviceId,
      environmentId,
    });
  }

  // ── Variables ──────────────────────────────────────────────────────────────

  async variables(projectId: string, environmentId: string, serviceId: string) {
    const { variables } = await this.gql<{ variables: Record<string, string> }>(
      `query ($projectId: String!, $environmentId: String!, $serviceId: String!) {
        variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
      }`,
      { projectId, environmentId, serviceId },
    );
    return variables;
  }

  /** Sets variables without deploying. */
  async setVariables(projectId: string, environmentId: string, serviceId: string, variables: Record<string, string>) {
    await this.gql(`mutation ($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`, {
      input: { projectId, environmentId, serviceId, variables, skipDeploys: true },
    });
  }

  // ── Volumes ────────────────────────────────────────────────────────────────

  async createVolume(projectId: string, environmentId: string, serviceId: string, mountPath: string) {
    await this.gql(`mutation ($input: VolumeCreateInput!) { volumeCreate(input: $input) { id } }`, {
      input: { projectId, environmentId, serviceId, mountPath },
    });
  }

  async deleteVolume(volumeId: string) {
    await this.gql(`mutation ($volumeId: String!) { volumeDelete(volumeId: $volumeId) }`, { volumeId });
  }

  // ── Networking ─────────────────────────────────────────────────────────────

  async domains(projectId: string, environmentId: string, serviceId: string) {
    const { domains } = await this.gql<{ domains: { serviceDomains: { id: string; domain: string; targetPort: number | null }[] } }>(
      `query ($projectId: String!, $environmentId: String!, $serviceId: String!) {
        domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) { serviceDomains { id domain targetPort } }
      }`,
      { projectId, environmentId, serviceId },
    );
    return domains.serviceDomains;
  }

  async createDomain(environmentId: string, serviceId: string, targetPort: number) {
    const { serviceDomainCreate } = await this.gql<{ serviceDomainCreate: { domain: string } }>(
      `mutation ($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }`,
      { input: { environmentId, serviceId, targetPort } },
    );
    return serviceDomainCreate.domain;
  }

  async deleteDomain(id: string) {
    await this.gql(`mutation ($id: String!) { serviceDomainDelete(id: $id) }`, { id });
  }

  /**
   * The service's private hostname, `<dnsName>.railway.internal`, and what's
   * needed to rename it. Railway takes it from the service's name, so a new
   * service already has the right one. `undefined` until it has an endpoint.
   */
  async privateEndpoint(environmentId: string, serviceId: string) {
    const { privateNetworks } = await this.gql<{ privateNetworks: { publicId: string }[] }>(
      `query ($environmentId: String!) { privateNetworks(environmentId: $environmentId) { publicId } }`,
      { environmentId },
    );
    const privateNetworkId = privateNetworks[0]?.publicId;
    if (!privateNetworkId) return undefined;
    const { privateNetworkEndpoint } = await this.gql<{ privateNetworkEndpoint: { publicId: string; dnsName: string } | null }>(
      `query ($environmentId: String!, $privateNetworkId: String!, $serviceId: String!) {
        privateNetworkEndpoint(environmentId: $environmentId, privateNetworkId: $privateNetworkId, serviceId: $serviceId) { publicId dnsName }
      }`,
      { environmentId, privateNetworkId, serviceId },
    );
    return privateNetworkEndpoint ? { id: privateNetworkEndpoint.publicId, dnsName: privateNetworkEndpoint.dnsName, privateNetworkId } : undefined;
  }

  async renamePrivateEndpoint(id: string, privateNetworkId: string, dnsName: string) {
    await this.gql(
      `mutation ($id: String!, $dnsName: String!, $privateNetworkId: String!) {
        privateNetworkEndpointRename(id: $id, dnsName: $dnsName, privateNetworkId: $privateNetworkId)
      }`,
      { id, dnsName, privateNetworkId },
    );
  }
}
