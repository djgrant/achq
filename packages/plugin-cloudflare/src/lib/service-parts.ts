import { achqStartScript, all, type Context, ENV, type EnvValues, type ManagedResource, type Service as AchqService, type VariableValues, VariableGroups } from "@achq/core";
import * as path from "node:path";
import { DATA_DIR, MANAGED_IMAGE, type WorkerSettings } from "../../worker/settings.ts";
import { BUN_VERSION, INSTANCE } from "./constants.ts";
import { Deployment } from "./deployment.ts";
import { KV_KEYS, serviceWorkerName } from "./names.ts";
import type { Project } from "./project.ts";
import { Variables } from "./variables.ts";
import { WORKER_DIR, workerConfig } from "./wrangler.ts";
import { Worker } from "./worker.ts";

/**
 * Runs `entry` (e.g. `packages/service-router/src/main.ts`) from achq at
 * ACHQ_REF, in Cloudflare's image, which has Node but not Bun: Bun is
 * installed under DATA_DIR on the first start. The script must not contain
 * single quotes, because it's quoted for the shell.
 */
export const startCommand = (entry: string) => {
  // Under DATA_DIR, which its snapshots keep.
  const script = achqStartScript(entry, { root: `"${DATA_DIR}/achq"`, timed: true });
  const bun = `${DATA_DIR}/bun`;
  return ["sh", "-c", `set -e; export PATH="${bun}/bin:$PATH"; command -v bun >/dev/null || npm install -g --prefix ${bun} bun@${BUN_VERSION}; exec bun -e '${script}'`];
};

/** One of achq's own services as Cloudflare resources: its Worker, its groups of variables, and its deploy. */
export class ServiceParts {
  readonly name: string;
  readonly worker: Worker;
  /** Its own variables, its first group: what every service has, and `own.variables`. */
  readonly first: Variables;
  private readonly namespaceId;
  private readonly groups: VariableGroups<Variables>;
  private made?: ManagedResource[];

  constructor(
    private readonly owner: AchqService,
    private readonly project: { name: string; resource: Project },
    /** `deployAfter`: what its deploy follows, e.g. a secret it starts with, asked for when it's planned. */
    private readonly own: { variables?: (ctx: Context) => EnvValues; wait: boolean; sshKeys?: string[]; deployAfter?: () => ManagedResource[] },
  ) {
    this.name = serviceWorkerName(project.name, owner.name);
    const at = project.resource.at();
    this.namespaceId = at.namespaceId;
    this.worker = new Worker("worker", { name: this.name, workersDev: at.workersDev, env: { namespaceId: this.namespaceId } }, { parent: owner });
    this.groups = new VariableGroups(this.name, (name, values) =>
      new Variables(
        name,
        { namespaceId: this.namespaceId, key: KV_KEYS.service(this.name), target: this.name, values },
        // After its Worker, so a first run plans the Worker before what's kept for it.
        { parent: owner, after: [this.worker] },
      ),
    );
    this.first = this.groups.add((ctx) => ({ ...own.variables?.(ctx), [ENV.dataDir]: DATA_DIR, PORT: String(owner.port) }));
  }

  variables(values: VariableValues) {
    return this.groups.add(values).outputs();
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
      entrypoint: startCommand(owner.entry),
      instance: INSTANCE,
      workersDev,
    };
  }

  /** Made once, when it's planned: no group of variables can be declared after. */
  children(ctx: Context) {
    if (this.made) return this.made;
    const { groups, variables } = this.groups.resolve(ctx);
    const at = this.project.resource.at();
    const config = all([at.workersDev, at.bucket]).map(([workersDev, bucket]) =>
      workerConfig(this.settings(workersDev), { main: path.join(WORKER_DIR, "index.ts"), bucket, sshKeys: this.own.sshKeys }),
    );
    const deploy = new Deployment(
      "deploy",
      { namespaceId: this.namespaceId, config, variables, ...(this.own.wait && { wait: this.worker.out("url") }) },
      { parent: this.owner, after: this.own.deployAfter?.() },
    );
    return (this.made = [this.worker, ...groups, deploy]);
  }
}
