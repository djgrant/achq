// The router or the deployer on Railway: an image service on the stock Bun
// image, its groups of variables, and its deploy, over its settings and every
// group's variables together, so it hashes as one map did before groups. Its
// start command downloads achq at ACHQ_REF, installs its dependencies once,
// and runs the service's entry point.
import { ACHQ_SOURCE, all, type Context, ENV, type EnvValues, type Input, type ManagedResource, type Output, type Service as AchqService } from "@achq/core";
import type { InstanceSettings } from "./client.ts";
import { BUN_IMAGE, VOLUME } from "./constants.ts";
import { Deployment, fingerprint } from "./deployment.ts";
import { hostServiceName } from "./names.ts";
import { Service } from "./service.ts";
import { Variables } from "./variables.ts";

/**
 * Runs `entry` (e.g. `packages/service-router/src/main.ts`) from achq at ACHQ_REF.
 * The download and `bun install` go on the service's volume, so a wake doesn't
 * repeat them. The script must not contain single quotes, because Railway
 * splits the command like a shell.
 */
export const startCommand = (entry: string) => {
  const script = [
    `const fs = require("node:fs");`,
    `const ref = process.env.ACHQ_REF;`,
    `if (!ref) throw new Error("Missing ACHQ_REF");`,
    `const dir = (process.env.RAILWAY_VOLUME_MOUNT_PATH ?? "/tmp") + "/achq/" + ref;`,
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
    `if (!fs.existsSync(dir + "/node_modules")) {`,
    `  const install = Bun.spawnSync(["bun", "install", "--production", "--frozen-lockfile"], { cwd: dir, stdout: "inherit", stderr: "inherit" });`,
    `  if (!install.success) throw new Error("bun install failed");`,
    `}`,
    `const entry = await import(dir + "/${entry}");`,
    `if (typeof entry.main === "function") await entry.main();`,
  ].join(" ");
  return `bun -e '${script}'`;
};


/** A group of variables, or how to make it when it's planned. */
type Values = EnvValues | ((ctx: Context) => EnvValues);

/** Its settings' key order is part of the deploy's fingerprint: reordering them redeploys. */
const settings = (service: AchqService): InstanceSettings => ({
  source: { image: BUN_IMAGE },
  startCommand: startCommand(service.entry),
  healthcheckPath: "/",
  sleepApplication: service.sleeps,
});

/** The resources a router or deployer is made of, named within it. */
export class ServiceParts {
  readonly name: string;
  readonly service: Service;
  /** Its own variables, its first group: what every service has, and `own.variables`. */
  readonly first: Variables;
  private readonly settings: InstanceSettings;
  private readonly at: { projectId: Input<string>; environmentId: Input<string>; serviceId: Input<string> };
  /** Each group's resource, what it was declared with, and the values it sets, filled in when planned if declared with a function. */
  private readonly groups: { variables: Variables; declared: Values; values: EnvValues }[] = [];
  private made?: ManagedResource[];

  constructor(
    private readonly owner: AchqService,
    at: { projectId: Input<string>; environmentId: Input<string> },
    private readonly own: { variables?: (ctx: Context) => EnvValues; wait: boolean },
  ) {
    this.name = hostServiceName(owner.name);
    this.settings = settings(owner);
    this.service = new Service(
      "service",
      { at, name: this.name, settings: this.settings, volume: VOLUME, ...(owner.public && { publicPort: owner.port }), env: true },
      { parent: owner },
    );
    this.at = { ...at, serviceId: this.service.out("serviceId") };
    this.first = this.group((ctx) => ({ ...own.variables?.(ctx), [ENV.dataDir]: VOLUME, PORT: String(owner.port) }));
  }

  variables(values: Values): Output<Record<string, string>> {
    return this.group(values).outputs();
  }

  private group(declared: Values) {
    if (this.made) throw new Error(`${this.name}: variables declared after it was planned`);
    const n = this.groups.length;
    const values = typeof declared === "function" ? {} : declared;
    const variables = new Variables(n ? `variables-${n + 1}` : "variables", { at: this.at, service: this.name, values }, { parent: this.owner });
    this.groups.push({ variables, declared, values });
    return variables;
  }

  children(ctx: Context): ManagedResource[] {
    return (this.made ??= this.make(ctx));
  }

  private make(ctx: Context): ManagedResource[] {
    for (const g of this.groups) if (typeof g.declared === "function") Object.assign(g.values, g.declared(ctx));
    this.once();
    const groups = this.groups.map((g) => g.variables);
    const deploy = new Deployment(
      "deploy",
      {
        at: this.at,
        service: this.name,
        fingerprint: all(groups.map((g) => g.outputs())).map((maps) => fingerprint({ settings: this.settings, variables: Object.assign({}, ...maps) })),
        wait: this.own.wait,
      },
      { parent: this.owner },
    );
    return [this.service, ...groups, deploy];
  }

  /** Two groups setting one variable would undo each other on every apply. */
  private once() {
    const seen = new Set<string>();
    const twice = new Set<string>();
    for (const { values } of this.groups) for (const k of Object.keys(values)) (seen.has(k) ? twice : seen).add(k);
    if (twice.size) throw new Error(`${this.name}: ${[...twice].join(", ")} declared in two groups of variables`);
  }
}
