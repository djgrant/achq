import { DATA_DIR, MANAGED_IMAGE, type WorkerSettings } from "@achq/cloudflare-worker/settings";
import { all, type EnvValues, type ManagedResource, type Output, type Placement, type Service as AchqService } from "@achq/core";
import { BUN_VERSION, INSTANCE } from "./constants.ts";
import { Deployment } from "./deployment.ts";
import { KV_KEYS, privateUrl, serviceWorkerName } from "./names.ts";
import type { Project } from "./project.ts";
import { Variables } from "./variables.ts";
import { WORKER_MAIN, workerConfig } from "./wrangler.ts";
import { Worker } from "./worker.ts";

/**
 * Runs `pkg` (e.g. `@achq/router`) at `version` from npm, in Cloudflare's
 * image, which has Node but not Bun: Bun is installed under DATA_DIR on the
 * first start, and keeps its cache there, which its snapshots keep, so only a
 * new version is downloaded.
 */
export const startCommand = (pkg: string, version: string) => {
  const bun = `${DATA_DIR}/bun`;
  return [
    "sh",
    "-c",
    `set -e; export PATH="${bun}/bin:$PATH" BUN_INSTALL_CACHE_DIR="${DATA_DIR}/bun-cache"; command -v bun >/dev/null || npm install -g --prefix ${bun} bun@${BUN_VERSION}; exec bunx ${pkg}@${version}`,
  ];
};

/** Where one of achq's own services runs on Cloudflare: its Worker, in `project`, and its deploy. */
export class ServiceParts implements Placement {
  readonly name: string;
  readonly dataDir = DATA_DIR;
  readonly worker: Worker;
  private readonly namespaceId;

  constructor(
    private readonly owner: AchqService,
    private readonly project: { name: string; resource: Project },
    /** `deployAfter`: what its deploy follows, e.g. a secret it starts with, asked for when it's planned. */
    private readonly own: { wait: boolean; sshKeys?: string[]; deployAfter?: () => ManagedResource[] },
  ) {
    this.name = serviceWorkerName(project.name, owner.name);
    const at = project.resource.at();
    this.namespaceId = at.namespaceId;
    this.worker = new Worker("worker", { name: this.name, workersDev: at.workersDev }, { parent: owner });
  }

  privateUrl(port: number) {
    return privateUrl(this.name, port);
  }

  group(name: string, values: EnvValues) {
    return new Variables(
      name,
      { namespaceId: this.namespaceId, key: KV_KEYS.service(this.name), target: this.name, values },
      // After its Worker, so a first run plans the Worker before what's kept for it.
      { parent: this.owner, after: [this.worker] },
    );
  }

  /** What the Worker is told about itself. */
  private settings(workersDev: string): WorkerSettings {
    const { owner } = this;
    return {
      name: this.name,
      port: owner.port,
      ...(owner.public && { publicPort: owner.port }),
      sleeps: owner.sleeps,
      restartOnChange: true,
      image: MANAGED_IMAGE,
      entrypoint: startCommand(owner.package, owner.version),
      instance: INSTANCE,
      workersDev,
    };
  }

  resources(groups: Variables[], variables: Output<Record<string, string>>) {
    const at = this.project.resource.at();
    const config = all([at.workersDev, at.bucket]).map(([workersDev, bucket]) =>
      workerConfig(this.settings(workersDev), { main: WORKER_MAIN, bucket, sshKeys: this.own.sshKeys }),
    );
    const deploy = new Deployment(
      "deploy",
      { namespaceId: this.namespaceId, config, variables, ...(this.own.wait && { wait: this.worker.out("url") }) },
      { parent: this.owner, after: this.own.deployAfter?.() },
    );
    return [this.worker, ...groups, deploy];
  }
}
