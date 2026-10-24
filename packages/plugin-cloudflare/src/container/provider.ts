import { type Context, type ContainerProvider, type ContainerShell, type ContainerSpec, containerOf, Output, plan, UNKNOWN } from "@achq/core";
import { context } from "@achq/core/context";
import { async } from "@achq/utils/async";
import { BUILD_STOPPED, BUILD_SUCCEEDED, CLOUDFLARE_API, Cloudflare } from "@achq/utils/cloudflare";
import { subprocess } from "@achq/utils/subprocess";
import { text } from "@achq/utils/text";
import { ENV_FILE } from "../../worker/lifecycle.ts";
import { archiveKey, SERVICE_CLASS } from "../../worker/settings.ts";
import { BUILD_POLL_INTERVAL_MS, BUILD_TIMEOUT_MS, BUILDS_GITHUB_APP_INSTALL_URL, CLOUDFLARE_ENV, CONTAINER_PROVIDER, LOG_TAIL_LINES, SOURCE_HOST, WRANGLER } from "../lib/constants.ts";
import { buildToken, registered } from "../lib/build-token.ts";
import { type ContainerPlace, containerParts } from "../lib/container-parts.ts";
import { containerUrl, containerWorkerName, KV_KEYS } from "../lib/names.ts";

/** Where it puts containers, and its own token, which it builds them with too. */
export type CloudflareContainerProviderOptions = Omit<ContainerPlace, "buildToken"> & {
  token: string;
  accountId: string;
  /** Cloudflare's API, for tests. */
  endpoint?: string;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};

/** What a build's failure says to check first, when its log doesn't. */
const cloneHint = (repo: string) => `If it couldn't clone ${repo}, install Cloudflare's GitHub App on it: ${BUILDS_GITHUB_APP_INSTALL_URL}`;

export class CloudflareContainerProvider implements ContainerProvider {
  readonly cf: Cloudflare;
  private readonly ctx: Context;
  /** Its Workers Builds token, found or registered once. */
  private buildToken?: Promise<string>;

  constructor(readonly options: CloudflareContainerProviderOptions) {
    const endpoint = options.endpoint ?? CLOUDFLARE_API;
    this.cf = new Cloudflare(options.token, options.accountId, endpoint);
    this.ctx = context({
      env: { [CLOUDFLARE_ENV.token]: options.token, [CLOUDFLARE_ENV.accountId]: options.accountId, [CLOUDFLARE_ENV.endpoint]: endpoint },
      sleep: options.sleep,
    });
  }

  private worker(repo: string, name: string) {
    return containerWorkerName(this.options.project, repo, name);
  }

  /** Not its build: `deploy` starts those. */
  private async parts(spec: ContainerSpec) {
    return containerParts(spec, { ...this.options, buildToken: await this.ownBuildToken(spec) });
  }

  /** Its Workers Builds token, registered the first time it's asked for. */
  private ownBuildToken(spec: ContainerSpec) {
    return (this.buildToken ??= buildToken(this.cf, this.options.token, this.worker(spec.repo, spec.name), this.options.log ?? ((line) => console.log(line))).catch((e) => {
      this.buildToken = undefined;
      throw e;
    }));
  }

  /** What `ensure` would change. Registers nothing: a token yet to be registered is unknown. */
  async plan(spec: ContainerSpec) {
    const { own } = await registered(this.cf);
    const parts = containerParts(spec, { ...this.options, buildToken: own ?? new Output<string>([], () => UNKNOWN) });
    return (await plan(parts.resources, this.ctx)).changes;
  }

  async ensure(spec: ContainerSpec) {
    // Workers Builds builds only from its source host.
    if (spec.host !== SOURCE_HOST) throw new Error(`Cloudflare builds containers from ${SOURCE_HOST} repos, not ${spec.host}`);
    const { name, resources } = await this.parts(spec);
    await (await plan(resources, this.ctx)).apply();
    return { url: containerUrl(name) };
  }

  /** Builds the branch's head with the Worker's trigger, waiting for it to deploy. A build that fails throws with the end of its log. */
  async deploy(repo: string, name: string) {
    const worker = this.worker(repo, name);
    const found = await this.cf.workers.get(worker);
    if (!found) throw new Error(`No Cloudflare Worker ${worker}; ensure it first`);
    const [trigger] = await this.cf.builds.triggers(found.id);
    const branch = trigger?.branch_includes[0];
    if (!trigger || !branch) throw new Error(`${worker} has no build trigger; ensure it first`);

    const started = await this.cf.builds.start(trigger.trigger_uuid, branch);
    const build = await async.pollOrThrow(
      () => this.cf.builds.get(started.build_uuid),
      (b) => b.status === BUILD_STOPPED,
      {
        intervalMs: BUILD_POLL_INTERVAL_MS,
        timeoutMs: BUILD_TIMEOUT_MS,
        sleep: this.ctx.sleep,
        timedOut: (after) => `${worker}'s build ${started.build_uuid} hasn't finished after ${after}`,
      },
    );
    if (build.build_outcome !== BUILD_SUCCEEDED) {
      const tail = text.tailLines((await this.cf.builds.log(build.build_uuid)).join("\n"), LOG_TAIL_LINES).join("\n");
      throw new Error(`${worker}'s build ${build.build_outcome ?? "failed"}:\n${tail}\n${cloneHint(repo)}`);
    }
    // Wrangler pushes the image before it uploads the Worker, so a build can succeed in pushing one that never went live.
    if (!(await this.image(worker, build.build_uuid))) throw new Error(`${worker}'s build ${build.build_uuid} deployed no version with a container image`);
  }

  /** The image the build deployed: its Worker version's, found among the latest by the build that made it. */
  async image(worker: string, build: string) {
    const versions = await this.cf.workers.versions(worker);
    const builds = await this.cf.builds.forVersions(versions.map((v) => v.id));
    const version = Object.entries(builds).find(([, b]) => b.build_uuid === build)?.[0];
    if (!version) return undefined;
    const { containers = [] } = await this.cf.workers.version(worker, version);
    return containers.find((c) => c.class_name === SERVICE_CLASS)?.images.app;
  }

  /** The repo and container of each Worker the deployer made, from the variables it keeps for them. */
  async list() {
    const { namespaceId } = this.options;
    const keys = await this.cf.kv.keys(namespaceId, KV_KEYS.containers);
    const containers = await Promise.all(
      keys.map(async (key) => containerOf((await this.cf.kv.getJson<Record<string, string>>(namespaceId, key)) ?? {})),
    );
    return containers.filter((c) => c !== undefined);
  }

  /**
   * Its trigger, its container application, its Worker with its Durable Object
   * and snapshots, its archive, and what's kept for it. The last one takes the
   * Builds token's registration with it: the next `ensure` registers it again.
   */
  async remove(repo: string, name: string) {
    const worker = this.worker(repo, name);
    const found = await this.cf.workers.get(worker);
    if (found) for (const trigger of await this.cf.builds.triggers(found.id)) await this.cf.builds.deleteTrigger(trigger.trigger_uuid);
    const application = await this.cf.containers.application(worker);
    if (application) await this.cf.containers.deleteApplication(application.id);
    if (found) await this.cf.workers.delete(worker);
    await this.cf.r2.deleteObject(this.options.bucket, archiveKey(worker));
    for (const key of [KV_KEYS.container(worker), KV_KEYS.deployed(worker)]) await this.cf.kv.delete(this.options.namespaceId, key);
    if ((await this.list()).length) return;
    this.buildToken = undefined;
    // Only its own: one made in the dashboard that it borrowed isn't achq's.
    const { own } = await registered(this.cf);
    if (own) await this.cf.builds.deleteToken(own);
  }

  /** Its container application, whose running instance `wrangler containers ssh` connects to. Known once its first build has deployed. */
  async locate(repo: string, name: string) {
    const worker = this.worker(repo, name);
    const application = await this.cf.containers.application(worker);
    return { containerProvider: CONTAINER_PROVIDER, account: this.options.accountId, worker, ...(application && { application: application.id }) };
  }
}

// ── The shell, on your machine ──

/** Runs the command with the container's environment, which `ssh` doesn't pass on; without one, a login shell. */
const withEnv = (command: string[]) => [
  "sh",
  "-c",
  command.length ? `set -a; . ${ENV_FILE}; exec "$@"` : `set -a; . ${ENV_FILE}; command -v bash >/dev/null && exec bash -l; exec sh -l`,
  "sh",
  ...command,
];

const wrangler = (location: Record<string, string>, args: string[]) => ({
  argv: [...WRANGLER, ...args],
  env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: location.account! },
});

/** The application's running instance: a Durable Object runs one. */
const runningInstance = async (location: Record<string, string>) => {
  const { argv, env } = wrangler(location, ["containers", "instances", location.application!, "--json"]);
  const stdout = await subprocess.output(argv, { env }, `Couldn't list ${location.worker}'s instances`);
  const instances = JSON.parse(stdout.slice(stdout.indexOf("["))) as { id: string; state?: string }[];
  const running = instances.find((i) => i.state === "running") ?? instances[0];
  if (!running) throw new Error(`${location.worker} has no running instance`);
  return running.id;
};

const sshArgs = (instance: string, command: string[], tty: boolean) => ["containers", "ssh", instance, ...(tty ? ["--tty"] : []), "--", ...withEnv(command)];

/** Through Wrangler, as you're signed in to it, with a key the deployer put in the container's `authorized_keys`. */
export const cloudflareShell: ContainerShell = {
  reachable: (location) => Boolean(location.account && location.application && location.worker),

  async open(location, command) {
    const { argv, env } = wrangler(location, sshArgs(await runningInstance(location), command, true));
    return Bun.spawn(argv, { env, stdio: ["inherit", "inherit", "inherit"] }).exited;
  },

  async run(location, command) {
    const { argv, env } = wrangler(location, sshArgs(await runningInstance(location), command, false));
    return subprocess.output(argv, { env }, `${command.join(" ")} failed in ${location.worker}`);
  },
};
