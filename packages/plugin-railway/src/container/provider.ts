import { BrowserActionNeeded, type Context, type ContainerProvider, type ContainerShell, type ContainerSpec, ENV, plan, repoName } from "@achq/core";
import { context } from "@achq/core/context";
import { RAILWAY_API, Railway, RailwayError, type RailwayProject } from "@achq/utils/railway";
import { subprocess } from "@achq/utils/subprocess";
import { BRANCH, CONNECTED, CONTAINER_PROVIDER, RAILWAY_ENV, REPO_UNSEEN, SOURCE_GITHUB_APP, SOURCE_GITHUB_APP_INSTALL_URL, SOURCE_HOST } from "../lib/constants.ts";
import { containerServiceName, containerUrl } from "../lib/names.ts";
import { containerService } from "../lib/service-parts.ts";

export type RailwayContainerProviderOptions = {
  token: string;
  projectId: string;
  environmentId: string;
  /** Railway's GraphQL endpoint, for tests. */
  endpoint?: string;
};

/** A branch as CONNECTED records it: `owner/repo@branch`. */
const connection = (repo: string, branch: string) => `${repo}@${branch}`;

/** Only Railway can tell that its App can't see a repo, and only you can install it there. */
const cantSee = (repo: string, error: RailwayError) =>
  new BrowserActionNeeded(`Railway can't see ${repo}: install its GitHub App (${SOURCE_GITHUB_APP}) on it, then deploy again. ${error.message}`, {
    url: SOURCE_GITHUB_APP_INSTALL_URL,
    what: `install ${SOURCE_GITHUB_APP} on ${repo}`,
  });

export class RailwayContainerProvider implements ContainerProvider {
  /** The deployer's project, in the environment its containers run in. */
  readonly project: RailwayProject;
  private readonly ctx: Context;

  constructor(readonly options: RailwayContainerProviderOptions) {
    const endpoint = options.endpoint ?? RAILWAY_API;
    this.project = new Railway(options.token, endpoint).project({ projectId: options.projectId, environmentId: options.environmentId });
    this.ctx = context({ env: { [RAILWAY_ENV.token]: options.token, [RAILWAY_ENV.endpoint]: endpoint } });
  }

  /** Not its deploy: `deploy` starts builds. */
  private resources(container: ContainerSpec) {
    return containerService(container, { projectId: this.project.id, environmentId: this.project.environmentId });
  }

  async plan(spec: ContainerSpec) {
    return (await plan(this.resources(spec), this.ctx)).changes;
  }

  async ensure(spec: ContainerSpec) {
    // Railway builds only from its source host.
    if (spec.host !== SOURCE_HOST) throw new Error(`Railway builds containers from ${SOURCE_HOST} repos, not ${spec.host}`);
    await (await plan(this.resources(spec), this.ctx)).apply();
    return { url: containerUrl(containerServiceName(spec.repo, spec.name)) };
  }

  async deploy(repo: string, name: string) {
    const serviceName = containerServiceName(repo, name);
    const found = await this.project.serviceByName(serviceName);
    if (!found) throw new Error(`No Railway service ${serviceName}; ensure it first`);
    const { service } = found;
    const [before, variables] = await Promise.all([service.instance(), service.variables()]);
    const branch = variables[BRANCH];
    if (!branch) throw new Error(`${serviceName} has no ${BRANCH}; ensure it first`);
    // It already builds from `repo`'s `branch` when Railway has the repo (in any case), and CONNECTED the branch.
    const source = before.source?.repo;
    if (source && repoName.same(source, repo) && variables[CONNECTED] === connection(repo, branch)) return service.deployLatestCommit();

    // Connecting builds the branch's head, and turns automatic deploys on, so they're turned off again.
    await service.connect(repo, branch).catch((error) => {
      throw error instanceof RailwayError && error.message.includes(REPO_UNSEEN) ? cantSee(repo, error) : error;
    });
    await service.setAutoDeploy(false);
    await service.setVariables({ [CONNECTED]: connection(repo, branch) });
    // Connecting usually starts a build. If the latest deploy is still the one from before connecting, it didn't, so one is started.
    const after = await service.instance();
    if (after.latestDeployment?.id === before.latestDeployment?.id) await service.deployLatestCommit();
  }

  /** The repo and container each service runs, from the variables the deployer set on it. A service that isn't a container's isn't listed. */
  async list() {
    const { services } = await this.project.snapshot();
    const containers = await Promise.all(
      services.map(async ({ id }) => {
        const variables = await this.project.service(id).variables();
        const repo = variables[ENV.repo];
        const name = variables[ENV.container];
        return repo && name ? { repo, name } : undefined;
      }),
    );
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

const requireRailwayCli = () => subprocess.requireBinary("railway", "the Railway CLI", "brew install railway");

export const railwayShell: ContainerShell = {
  reachable: (location) => Boolean(location.project && location.environment && location.service),

  async open(location, command) {
    requireRailwayCli();
    return Bun.spawn(["railway", ...sshArgs(location, command)], { stdio: ["inherit", "inherit", "inherit"] }).exited;
  },

  async run(location, command) {
    requireRailwayCli();
    const { ok, stdout, stderr } = await subprocess.collect(["railway", ...sshArgs(location, command)]);
    if (!ok) throw new Error(`${command.join(" ")} failed in ${location.service}: ${stderr.trim() || stdout.trim()}`);
    return stdout;
  },
};
