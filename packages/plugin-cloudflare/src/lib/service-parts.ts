import { ACHQ_SOURCE, all, type Context, ENV, type EnvValues, type ManagedResource, type Service as AchqService } from "@achq/core";
import { collections } from "@achq/utils/collections";
import * as path from "node:path";
import { DATA_DIR, MANAGED_IMAGE, type WorkerSettings } from "../../worker/settings.ts";
import { BUN_VERSION, INSTANCE } from "./constants.ts";
import { Deployment } from "./deployment.ts";
import { KV_KEYS, serviceWorkerName } from "./names.ts";
import type { Project } from "./project.ts";
import { Variables } from "./variables.ts";
import { WORKER_DIR, workerConfig } from "./wrangler.ts";
import { Worker } from "./worker.ts";

// The start command's script runs in the service's own Bun, not here, so it's
// written as source. Its parts are joined with spaces into one line, and that
// line is in the deploy's fingerprint: changing a character redeploys.

/** Where achq at ACHQ_REF goes: under DATA_DIR, which its snapshots keep, so a wake doesn't download it again. */
const LOCATE = [
  `const fs = require("node:fs");`,
  `const ref = process.env.ACHQ_REF;`,
  `if (!ref) throw new Error("Missing ACHQ_REF");`,
  `const dir = "${DATA_DIR}/achq/" + ref;`,
];

/** Downloads and unpacks it beside `dir`, then renames it into place, so an interrupted download is never taken for a finished one. */
const DOWNLOAD = [
  `if (!fs.existsSync(dir)) {`,
  `  const res = await fetch("${ACHQ_SOURCE.archive}" + ref);`,
  `  if (!res.ok) throw new Error("achq " + ref + ": " + res.status);`,
  `  const tmp = dir + ".tmp";`,
  `  fs.rmSync(tmp, { recursive: true, force: true });`,
  `  fs.mkdirSync(tmp, { recursive: true });`,
  `  await Bun.write(tmp + ".tgz", res);`,
  `  const tar = Bun.spawnSync(["tar", "xzf", tmp + ".tgz", "-C", tmp, "--strip-components=1"]);`,
  `  if (!tar.success) throw new Error("tar: " + tar.stderr);`,
  `  fs.rmSync(tmp + ".tgz");`,
  `  fs.renameSync(tmp, dir);`,
  `}`,
];

const INSTALL = [
  `if (!fs.existsSync(dir + "/node_modules")) {`,
  `  const install = Bun.spawnSync(["bun", "install", "--production", "--frozen-lockfile"], { cwd: dir, stdout: "inherit", stderr: "inherit" });`,
  `  if (!install.success) throw new Error("bun install failed");`,
  `}`,
];

/**
 * Runs `entry` (e.g. `packages/service-router/src/main.ts`) from achq at
 * ACHQ_REF, in Cloudflare's image, which has Node but not Bun: Bun is
 * installed under DATA_DIR on the first start. The script must not contain
 * single quotes, because it's quoted for the shell.
 */
export const startCommand = (entry: string) => {
  const run = [`const entry = await import(dir + "/${entry}");`, `if (typeof entry.main === "function") await entry.main();`];
  const script = [...LOCATE, ...DOWNLOAD, ...INSTALL, ...run].join(" ");
  const bun = `${DATA_DIR}/bun`;
  return ["sh", "-c", `set -e; export PATH="${bun}/bin:$PATH"; command -v bun >/dev/null || npm install -g --prefix ${bun} bun@${BUN_VERSION}; exec bun -e '${script}'`];
};

/** A group of variables, or how to make it when it's planned. */
type Values = EnvValues | ((ctx: Context) => EnvValues);

/** One of achq's own services as Cloudflare resources: its Worker, its groups of variables, and its deploy. */
export class ServiceParts {
  readonly name: string;
  readonly worker: Worker;
  /** Its own variables, its first group: what every service has, and `own.variables`. */
  readonly first: Variables;
  private readonly namespaceId;
  /** Each group's resource, what it was declared with, and the values it sets, filled in when planned if declared with a function. */
  private readonly groups: { variables: Variables; declared: Values; values: EnvValues }[] = [];
  private made?: ManagedResource[];

  constructor(
    private readonly owner: AchqService,
    private readonly project: { name: string; resource: Project },
    private readonly own: { variables?: (ctx: Context) => EnvValues; wait: boolean; sshKeys?: string[] },
  ) {
    this.name = serviceWorkerName(project.name, owner.name);
    this.namespaceId = project.resource.out("namespaceId");
    this.worker = new Worker("worker", { name: this.name, workersDev: project.resource.out("workersDev"), env: { namespaceId: this.namespaceId } }, { parent: owner });
    this.first = this.group((ctx) => ({ ...own.variables?.(ctx), [ENV.dataDir]: DATA_DIR, PORT: String(owner.port) }));
  }

  variables(values: Values) {
    return this.group(values).outputs();
  }

  private group(declared: Values) {
    if (this.made) throw new Error(`${this.name}: variables declared after it was planned`);
    const n = this.groups.length;
    const values = typeof declared === "function" ? {} : declared;
    const variables = new Variables(
      n ? `variables-${n + 1}` : "variables",
      { namespaceId: this.namespaceId, key: KV_KEYS.service(this.name), target: this.name, values },
      // After its Worker, so a first run plans the Worker before what's kept for it.
      { parent: this.owner, after: [this.worker] },
    );
    this.groups.push({ variables, declared, values });
    return variables;
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
    for (const group of this.groups) {
      if (typeof group.declared === "function") Object.assign(group.values, group.declared(ctx));
    }
    // Two groups setting one variable would undo each other on every apply.
    const shared = collections.duplicates(this.groups.flatMap(({ values }) => Object.keys(values)));
    if (shared.length) throw new Error(`${this.name}: ${shared.join(", ")} declared in two groups of variables`);
    const groups = this.groups.map((g) => g.variables);
    const variables = all(groups.map((g) => g.outputs())).map((maps): Record<string, string> => Object.assign({}, ...maps));
    const at = this.project.resource.at();
    const config = all([at.workersDev, at.bucket]).map(([workersDev, bucket]) =>
      workerConfig(this.settings(workersDev), { main: path.join(WORKER_DIR, "index.ts"), bucket, sshKeys: this.own.sshKeys }),
    );
    const deploy = new Deployment(
      "deploy",
      { namespaceId: this.namespaceId, config, variables, ...(this.own.wait && { wait: this.worker.out("url") }) },
      { parent: this.owner },
    );
    return (this.made = [this.worker, ...groups, deploy]);
  }
}
