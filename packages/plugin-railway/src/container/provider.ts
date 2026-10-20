import { type Change, type Context, type ContainerProvider, type ContainerShell, type ContainerSpec, ENV, plan } from "@achq/core";
import { randomHex } from "@achq/utils/crypto";
import { requireBinary, spawnCollect } from "@achq/utils/process";
import { type Instance, RAILWAY_API, Railway, type RailwayProject, type RailwayService } from "@achq/utils/railway";
import { BRANCH, CONNECTED, CONTAINER_PROVIDER, RAILWAY_ENV, SOURCE_HOST } from "../lib/constants.ts";
import { containerService } from "../lib/container-service.ts";
import { containerServiceName, containerUrl } from "../lib/names.ts";

export type RailwayContainerProviderOptions = {
  token: string;
  projectId: string;
  environmentId: string;
  /** Railway's GraphQL endpoint, for tests. */
  endpoint?: string;
};

const SECRET_BYTES = 32;

export class RailwayContainerProvider implements ContainerProvider {
  /** The deployer's project, in the environment its containers run in. */
  readonly project: RailwayProject;
  private readonly ctx: Context;

  constructor(readonly options: RailwayContainerProviderOptions) {
    const endpoint = options.endpoint ?? RAILWAY_API;
    this.project = new Railway(options.token, endpoint).project({ projectId: options.projectId, environmentId: options.environmentId });
    this.ctx = {
      env: { [RAILWAY_ENV.token]: options.token, [RAILWAY_ENV.endpoint]: endpoint },
      log: () => {},
      newSecret: () => randomHex(SECRET_BYTES),
      sleep: (ms) => Bun.sleep(ms),
    };
  }

  /** Not its deploy: `deploy` starts builds. */
  private resources(container: ContainerSpec) {
    return containerService(container, { projectId: this.project.id, environmentId: this.project.environmentId });
  }

  async plan(spec: ContainerSpec): Promise<Change[]> {
    return (await plan(this.resources(spec), this.ctx)).changes;
  }

  async ensure(spec: ContainerSpec) {
    assertBuildable(spec);
    await (await plan(this.resources(spec), this.ctx)).apply();
    return { url: containerUrl(containerServiceName(spec.repo, spec.name)) };
  }

  async deploy(repo: string, name: string) {
    const serviceName = containerServiceName(repo, name);
    const found = await this.project.serviceByName(serviceName);
    if (!found) throw new Error(`No Railway service ${serviceName}; ensure it first`);
    const { service } = found;
    const [instance, variables] = await Promise.all([service.instance(), service.variables()]);
    const branch = variables[BRANCH];
    if (!branch) throw new Error(`${serviceName} has no ${BRANCH}; ensure it first`);
    if (isConnected(instance, variables, repo, branch)) return service.deployLatestCommit();
    await connectBranch(service, repo, branch);
    await deployIfConnectStartedNothing(service, instance);
  }

  async list() {
    const { services } = await this.project.snapshot();
    const containers = await Promise.all(services.map((s) => containerOf(this.project.service(s.id))));
    return containers.filter((c) => c !== undefined);
  }

  async remove(repo: string, name: string) {
    const found = await this.project.serviceByName(containerServiceName(repo, name));
    if (!found) return;
    await found.service.delete();
    // Deleting a service doesn't necessarily delete its volume.
    for (const volume of found.volumes) await this.project.deleteVolume(volume.id);
  }

  async locate(repo: string, name: string) {
    return { containerProvider: CONTAINER_PROVIDER, project: this.options.projectId, environment: this.options.environmentId, service: containerServiceName(repo, name) };
  }
}

/** Railway builds only from its source host. */
const assertBuildable = (spec: ContainerSpec) => {
  if (spec.host !== SOURCE_HOST) throw new Error(`Railway builds containers from ${SOURCE_HOST} repos, not ${spec.host}`);
};

/** A branch as CONNECTED records it: `owner/repo@branch`. */
const connection = (repo: string, branch: string) => `${repo}@${branch}`;

/** Whether the service already builds from `repo`'s `branch`: Railway has the repo (in any case), and CONNECTED the branch. */
const isConnected = (instance: Instance, variables: Record<string, string>, repo: string, branch: string) =>
  instance.source?.repo?.toLowerCase() === repo.toLowerCase() && variables[CONNECTED] === connection(repo, branch);

/** Connects the service to the branch, which builds its head. Connecting turns automatic deploys on, so they're turned off again. */
const connectBranch = async (service: RailwayService, repo: string, branch: string) => {
  await service.connect(repo, branch);
  await service.setAutoDeploy(false);
  await service.setVariables({ [CONNECTED]: connection(repo, branch) });
};

/** Connecting usually starts a build. If the latest deploy is still the one from `before` connecting, it didn't, so one is started. */
const deployIfConnectStartedNothing = async (service: RailwayService, before: Instance) => {
  const after = await service.instance();
  if (after.latestDeployment?.id === before.latestDeployment?.id) await service.deployLatestCommit();
};

/** The repo and container a service runs, from the variables the deployer set on it. Undefined for a service that isn't a container's. */
const containerOf = async (service: RailwayService) => {
  const variables = await service.variables();
  const repo = variables[ENV.repo];
  const name = variables[ENV.container];
  return repo && name ? { repo, name } : undefined;
};

const sshArgs = (location: Record<string, string>, command: string[]) => [
  "ssh",
  "--project",
  location.project!,
  "--environment",
  location.environment!,
  "--service",
  location.service!,
  ...(command.length ? ["--", ...command] : []),
];

const requireRailwayCli = () => requireBinary("railway", "the Railway CLI", "brew install railway");

export const railwayShell: ContainerShell = {
  reachable: (location) => Boolean(location.project && location.environment && location.service),

  async open(location, command) {
    requireRailwayCli();
    return Bun.spawn(["railway", ...sshArgs(location, command)], { stdio: ["inherit", "inherit", "inherit"] }).exited;
  },

  async run(location, command) {
    requireRailwayCli();
    const { ok, stdout, stderr } = await spawnCollect(["railway", ...sshArgs(location, command)]);
    if (!ok) throw new Error(`${command.join(" ")} failed in ${location.service}: ${stderr.trim() || stdout.trim()}`);
    return stdout;
  },
};
