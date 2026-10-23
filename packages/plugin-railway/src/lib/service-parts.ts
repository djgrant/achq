import { ACHQ_SOURCE, all, CONTAINER_PORT, type ContainerSpec, type Context, ENV, type EnvValues, type Input, type ManagedResource, type Service as AchqService } from "@achq/core";
import { collections } from "@achq/utils/collections";
import type { InstanceSettings, ProjectAt } from "@achq/utils/railway";
import { BRANCH, BUN_IMAGE, VOLUME } from "./constants.ts";
import { Deployment, fingerprint } from "./deployment.ts";
import { containerServiceName, hostServiceName } from "./names.ts";
import { Service } from "./service.ts";
import { Variables } from "./variables.ts";

// The start command's script runs in the service's own Bun, not here, so it's
// written as source. Its parts are joined with spaces into one line, and that
// line is in the deploy's fingerprint: changing a character redeploys.

/** Where achq at ACHQ_REF goes: on the volume, so a wake doesn't download it again. */
const LOCATE = [
  `const fs = require("node:fs");`,
  `const ref = process.env.ACHQ_REF;`,
  `if (!ref) throw new Error("Missing ACHQ_REF");`,
  `const root = (process.env.RAILWAY_VOLUME_MOUNT_PATH ?? "/tmp") + "/achq";`,
  `const dir = root + "/" + ref;`,
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

/** Deletes every other ref once this one's ready: each is a copy of achq with its node_modules, which would otherwise fill the volume a push at a time. */
const PRUNE = [`for (const other of fs.readdirSync(root)) if (other !== ref) fs.rmSync(root + "/" + other, { recursive: true, force: true });`];

/**
 * Runs `entry` (e.g. `packages/service-router/src/main.ts`) from achq at
 * ACHQ_REF. The script must not contain single quotes, because Railway splits
 * the command like a shell.
 */
export const startCommand = (entry: string) => {
  const run = [`const entry = await import(dir + "/${entry}");`, `if (typeof entry.main === "function") await entry.main();`];
  const script = [...LOCATE, ...DOWNLOAD, ...INSTALL, ...PRUNE, ...run].join(" ");
  return `bun -e '${script}'`;
};

/** A group of variables, or how to make it when it's planned. */
type Values = EnvValues | ((ctx: Context) => EnvValues);

/** One of achq's own services as Railway resources: its service, its groups of variables, and its deploy. */
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
    // Its settings' key order is part of the deploy's fingerprint: reordering them redeploys.
    this.settings = { source: { image: BUN_IMAGE }, startCommand: startCommand(owner.entry), healthcheckPath: "/", sleepApplication: owner.sleeps };
    this.service = new Service(
      "service",
      { at, name: this.name, settings: this.settings, volume: VOLUME, ...(owner.public && { publicPort: owner.port }), env: true },
      { parent: owner },
    );
    this.at = { ...at, serviceId: this.service.out("serviceId") };
    this.first = this.group((ctx) => ({ ...own.variables?.(ctx), [ENV.dataDir]: VOLUME, PORT: String(owner.port) }));
  }

  variables(values: Values) {
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
    // Over every group's variables as one map, as it hashed before variables came in groups.
    const variables = all(groups.map((g) => g.outputs())).map((maps): Record<string, string> => Object.assign({}, ...maps));
    const deploy = new Deployment(
      "deploy",
      { at: this.at, service: this.name, fingerprint: variables.map((v) => fingerprint({ settings: this.settings, variables: v })), wait: this.own.wait },
      { parent: this.owner },
    );
    return (this.made = [this.service, ...groups, deploy]);
  }
}

/**
 * One Railway service per repo and container: private, sleeping when idle,
 * and its variables. Not its deploy: the deployer starts its builds.
 */
export const containerService = (container: ContainerSpec, at: ProjectAt) => {
  const name = containerServiceName(container.repo, container.name);
  const service = new Service(
    name,
    {
      at,
      name,
      settings: {
        // Setting a Dockerfile path is what makes Railway build with Docker.
        dockerfilePath: container.dockerfile,
        healthcheckPath: "/",
        // Sleeps when idle; the router wakes it over the private network.
        sleepApplication: true,
      },
      volume: VOLUME,
      // Once connected, Railway would deploy every push to the branch. The deployer starts builds itself.
      autoDeploy: false,
    },
    { declared: false },
  );
  const variables = new Variables(
    "variables",
    {
      at: { ...at, serviceId: service.out("serviceId") },
      service: name,
      values: {
        ...container.env,
        [BRANCH]: container.branch,
        [ENV.dataDir]: VOLUME,
        PORT: String(CONTAINER_PORT),
        // Railway sleeps a service 5–10 minutes after its last outbound packet, and private traffic counts.
        [ENV.keepAwakeUrl]: `${container.env[ENV.routerUrl]}/`,
      },
    },
    { parent: service },
  );
  return [service, variables];
};
