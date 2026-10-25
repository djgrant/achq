import { BrowserActionNeeded, type Context, type ContainerProvider, type ContainerShell, type ContainerSpec, containerOf, plan, repoName } from "@achq/core";
import { context } from "@achq/core/context";
import { RAILWAY_API, Railway, RailwayError, type RailwayProject, type RailwayService } from "@achq/utils/railway";
import { subprocess } from "@achq/utils/subprocess";
import { CONNECTED, CONTAINER_PROVIDER, RAILWAY_ENV, REPO_UNSEEN, SOURCE_GITHUB_APP, SOURCE_GITHUB_APP_INSTALL_URL } from "../lib/constants.ts";
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

// compat: delete once deployed infras run past ed5cfe9. Deletes ACHQ_PRIVATE_ENV, which an agent would now see, and ACHQ_BRANCH where an older deployer left them: a variable group never deletes them.
const STALE = ["ACHQ_PRIVATE_ENV", "ACHQ_BRANCH"];
const dropStale = async (service: RailwayService) => {
  const variables = await service.variables();
  for (const name of STALE) if (name in variables) await service.deleteVariable(name);
};

export class RailwayContainerProvider implements ContainerProvider {
  /** The deployer's project, in the environment its containers run in. */
  readonly project: RailwayProject;
  private readonly ctx: Context;

  constructor(readonly options: RailwayContainerProviderOptions) {
    const endpoint = options.endpoint ?? RAILWAY_API;
    this.project = new Railway(options.token, endpoint).project({ projectId: options.projectId, environmentId: options.environmentId });
    this.ctx = context({ env: { [RAILWAY_ENV.token]: options.token, [RAILWAY_ENV.endpoint]: endpoint } });
  }

  async ensure(spec: ContainerSpec, { build }: { build: boolean }) {
    const { service, resources } = containerService(spec, { projectId: this.project.id, environmentId: this.project.environmentId });
    const applied = await (await plan(resources, this.ctx)).apply();
    const made = this.project.service(applied.value(service.out("serviceId")));
    await dropStale(made);
    if (build) await this.build(made, spec);
    return { url: containerUrl(containerServiceName(spec.repo, spec.name)) };
  }

  /** Builds the head of the spec's branch: by connecting the service to it the first time, then by deploying its latest commit. */
  private async build(service: RailwayService, { repo, branch }: ContainerSpec) {
    const [before, variables] = await Promise.all([service.instance(), service.variables()]);
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
      services.map(async ({ id }) => containerOf(await this.project.service(id).variables())),
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
    return subprocess.output(["railway", ...sshArgs(location, command)], {}, `${command.join(" ")} failed in ${location.service}`);
  },
};
