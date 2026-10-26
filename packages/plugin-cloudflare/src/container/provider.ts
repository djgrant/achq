import { archiveKey, ENV_FILE, SERVICE_CLASS } from "@achq/cloudflare-worker/settings";
import { type Context, type ContainerProvider, type ContainerSpec, containerOf, plan } from "@achq/core";
import { context } from "@achq/core/context";
import { async } from "@achq/utils/async";
import { BUILD_STOPPED, BUILD_SUCCEEDED, CLOUDFLARE_API, Cloudflare } from "@achq/utils/cloudflare";
import { text } from "@achq/utils/text";
import { BUILD_POLL_INTERVAL_MS, BUILD_TIMEOUT_MS, BUILDS_GITHUB_APP_INSTALL_URL, CLOUDFLARE_ENV, LOG_TAIL_LINES, NPX, WRANGLER } from "../lib/constants.ts";
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

  /** Its Workers Builds token, registered the first time it's asked for. */
  private ownBuildToken(spec: ContainerSpec) {
    return (this.buildToken ??= buildToken(this.cf, this.options.token, this.worker(spec.repo, spec.name), this.options.log ?? ((line) => console.log(line))).catch((e) => {
      this.buildToken = undefined;
      throw e;
    }));
  }

  async ensure(spec: ContainerSpec, { build }: { build: boolean }) {
    const { name, trigger, resources } = containerParts(spec, { ...this.options, buildToken: await this.ownBuildToken(spec) });
    const applied = await (await plan(resources, this.ctx)).apply();
    if (build) await this.build(name, applied.value(trigger.out("trigger")), spec);
    return { url: containerUrl(name) };
  }

  /** Builds the branch's head with the Worker's trigger, waiting for it to deploy. A build that fails throws with the end of its log. */
  private async build(worker: string, trigger: string, { repo, branch }: ContainerSpec) {
    const started = await this.cf.builds.start(trigger, branch);
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

  /**
   * Through Wrangler, as you're signed in to it, with a key the deployer put in
   * the container's `authorized_keys`, to its application's running instance:
   * a Durable Object runs one, and its id changes when it's replaced.
   */
  async shell(repo: string, name: string, command: string[], tty: boolean) {
    const worker = this.worker(repo, name);
    const application = await this.cf.containers.application(worker);
    if (!application) throw new Error(`${worker} has no container yet: its first build hasn't deployed`);
    const instances = await this.cf.containers.instances(application.id);
    const instance = (instances.find((i) => i.running) ?? instances[0])?.id;
    if (!instance) throw new Error(`${worker} has no running instance`);
    return {
      argv: [...WRANGLER, "containers", "ssh", instance, ...(tty ? ["--tty"] : []), "--", ...withEnv(command)],
      env: { CLOUDFLARE_ACCOUNT_ID: this.options.accountId },
      requires: [NPX],
    };
  }
}

/** Runs the command with the container's environment, which `ssh` doesn't pass on; without one, a login shell. */
const withEnv = (command: string[]) => [
  "sh",
  "-c",
  command.length ? `set -a; . ${ENV_FILE}; exec "$@"` : `set -a; . ${ENV_FILE}; command -v bash >/dev/null && exec bash -l; exec sh -l`,
  "sh",
  ...command,
];
