// One service in one environment: its instance's settings and deploys, its
// variables, volume and networking.
import { OPERATIONS } from "./operations.ts";
import type { RailwayTransport } from "./transport.ts";
import type { Instance, InstanceAt, InstanceSettings, PrivateEndpoint, ServiceAt, ServiceDomain } from "./types.ts";

export class RailwayService {
  readonly id: string;

  constructor(
    private readonly transport: RailwayTransport,
    private readonly at: ServiceAt,
  ) {
    this.id = at.serviceId;
  }

  /** The service in its environment, for the operations that don't need its project. */
  private get instanceAt(): InstanceAt {
    return { environmentId: this.at.environmentId, serviceId: this.at.serviceId };
  }

  async delete() {
    await this.transport.call(OPERATIONS.serviceDelete, { id: this.id, environmentId: this.at.environmentId });
  }

  // ── Settings and deploys ───────────────────────────────────────────────────

  instance(): Promise<Instance> {
    return this.transport.call(OPERATIONS.serviceInstance, this.instanceAt);
  }

  async update(settings: InstanceSettings) {
    await this.transport.call(OPERATIONS.serviceInstanceUpdate, { ...this.instanceAt, input: settings });
  }

  /** Connects it to a GitHub repo and branch. Railway starts a build from it, and turns automatic deploys on. */
  async connect(repo: string, branch: string) {
    await this.transport.call(OPERATIONS.serviceConnect, { id: this.id, input: { repo, branch } });
  }

  /** Whether Railway deploys on every push to the connected branch. */
  autoDeploy(): Promise<boolean> {
    return this.transport.call(OPERATIONS.serviceInstanceAutoDeployStatus, this.at);
  }

  async setAutoDeploy(enabled: boolean) {
    await this.transport.call(OPERATIONS.serviceInstanceAutoDeployUpdate, { input: { ...this.at, enabled } });
  }

  /** Builds and deploys the head of the connected branch. */
  async deployLatestCommit() {
    await this.transport.call(OPERATIONS.serviceInstanceDeploy, this.instanceAt);
  }

  /** Deploys an image service with its current settings and variables. */
  async deployImage() {
    await this.transport.call(OPERATIONS.serviceInstanceDeployV2, this.instanceAt);
  }

  // ── Variables and volumes ──────────────────────────────────────────────────

  variables(): Promise<Record<string, string>> {
    return this.transport.call(OPERATIONS.variables, this.at);
  }

  /** Sets these variables, leaving the rest, without deploying. */
  async setVariables(variables: Record<string, string>) {
    await this.transport.call(OPERATIONS.variableCollectionUpsert, { input: { ...this.at, variables, skipDeploys: true } });
  }

  async addVolume(mountPath: string) {
    await this.transport.call(OPERATIONS.volumeCreate, { input: { ...this.at, mountPath } });
  }

  // ── Networking ─────────────────────────────────────────────────────────────

  /** Its public `*.up.railway.app` domains. */
  domains(): Promise<ServiceDomain[]> {
    return this.transport.call(OPERATIONS.domains, this.at);
  }

  /** A new public domain routed to `targetPort`, by name. */
  addDomain(targetPort: number): Promise<string> {
    return this.transport.call(OPERATIONS.serviceDomainCreate, { input: { ...this.instanceAt, targetPort } });
  }

  async deleteDomain(domainId: string) {
    await this.transport.call(OPERATIONS.serviceDomainDelete, { id: domainId });
  }

  /**
   * Its private hostname. Railway takes it from the service's name, so a new
   * service already has the right one. Undefined until it has an endpoint,
   * which it gets on its first deploy.
   */
  async privateEndpoint(): Promise<PrivateEndpoint | undefined> {
    const [privateNetworkId] = await this.transport.call(OPERATIONS.privateNetworks, { environmentId: this.at.environmentId });
    if (!privateNetworkId) return undefined;
    const endpoint = await this.transport.call(OPERATIONS.privateNetworkEndpoint, { ...this.instanceAt, privateNetworkId });
    return endpoint ? { id: endpoint.publicId, dnsName: endpoint.dnsName, privateNetworkId } : undefined;
  }

  async renamePrivateEndpoint(endpoint: PrivateEndpoint, dnsName: string) {
    await this.transport.call(OPERATIONS.privateNetworkEndpointRename, { id: endpoint.id, dnsName, privateNetworkId: endpoint.privateNetworkId });
  }
}
