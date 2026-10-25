import { APP_IMAGE, DATA_DIR, INTERNAL_HOSTS, type WorkerSettings } from "@achq/cloudflare-worker/settings";
import { CONTAINER_PORT, type ContainerSpec, ENV, type Input } from "@achq/core";
import { BuildTrigger, CONTAINER_MAIN } from "./build-trigger.ts";
import { workerSecrets } from "./cloudflare.ts";
import { INSTANCE } from "./constants.ts";
import { containerWorkerName, KV_KEYS } from "./names.ts";
import { Secrets } from "./secrets.ts";
import { Variables } from "./variables.ts";
import { Worker } from "./worker.ts";
import { workerConfig } from "./wrangler.ts";

/** Where the deployer puts containers, from its own variables. */
export type ContainerPlace = {
  project: string;
  namespaceId: string;
  bucket: string;
  workersDev: string;
  /** Unknown while planning, if it's yet to be registered. */
  buildToken: Input<string>;
  sshKeys: string[];
  /** AGENT_WEBHOOK_KEY, which each Worker's internal key derives from. */
  key: string;
};

/**
 * One Worker per repo and container, sleeping when idle, built from the repo
 * by its Builds trigger: the Worker, its variables, kept readable in the
 * namespace and set as its secrets, and its trigger. Not its build: `ensure`
 * starts one with the trigger when the deployer asks.
 */
export const containerParts = (spec: ContainerSpec, place: ContainerPlace) => {
  const name = containerWorkerName(place.project, spec.repo, spec.name);
  const ref = spec.env[ENV.ref];
  if (!ref) throw new Error(`${spec.repo}'s ${spec.name} has no ${ENV.ref}: the achq Worker its build deploys is taken from that commit`);
  const worker = new Worker(name, { name, workersDev: place.workersDev }, { declared: false });
  const values = {
    ...spec.env,
    [ENV.dataDir]: DATA_DIR,
    PORT: String(CONTAINER_PORT),
    // Its Worker puts it to sleep once nothing has reached it, or been fetched from here, for a while.
    [ENV.keepAwakeUrl]: `http://${INTERNAL_HOSTS.awake}/`,
  };
  const variables = new Variables("variables", { namespaceId: place.namespaceId, key: KV_KEYS.container(name), target: name, values }, { parent: worker });
  const secrets = new Secrets(
    "secrets",
    { namespaceId: place.namespaceId, worker: name, tag: worker.out("tag"), secrets: workerSecrets(values, place.key) },
    { parent: worker, after: [variables] },
  );
  const settings: WorkerSettings = {
    name,
    port: CONTAINER_PORT,
    sleeps: true,
    restartOnChange: false,
    image: APP_IMAGE,
    instance: INSTANCE,
    workersDev: place.workersDev,
  };
  // The Dockerfile's path is from the repo's root, where the build writes the config.
  const images = { [APP_IMAGE]: { dockerfile: `./${spec.dockerfile}`, build_context: "." } };
  const config = workerConfig(settings, { main: CONTAINER_MAIN, bucket: place.bucket, images, sshKeys: place.sshKeys });
  const trigger = new BuildTrigger(
    "build",
    { worker: name, tag: worker.out("tag"), repo: spec.repo, identity: spec.identity, branch: spec.branch, buildToken: place.buildToken, config, ref },
    { parent: worker },
  );
  return { name, trigger, resources: [worker, variables, secrets, trigger] };
};
