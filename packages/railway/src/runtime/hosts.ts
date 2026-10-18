// The router and deployer run on the stock Bun image. Their start command
// downloads achq at ACHQ_REF, installs its dependencies once, and runs the
// service's entry point.
import { DEPLOYER_PORT, ENV, ROUTER_PRIVATE_PORT, ROUTER_PUBLIC_PORT, type DeployerHost, type RouterHost } from "@achq/core";
import { type ServiceSpec, serviceName } from "./service.ts";

/** Where achq's own code is downloaded from. */
export const ACHQ_SOURCE = "djgrant/achq";
export const BUN_IMAGE = "oven/bun:1-slim";

export class RailwayRouterHost implements RouterHost {
  readonly platform = "railway";
  constructor(readonly project: string) {}
}

export class RailwayDeployerHost implements DeployerHost {
  readonly platform = "railway";
  constructor(readonly project: string) {}
}

/** The service a router or deployer resource runs as. */
export const hostServiceName = (resource: string) => serviceName("achq", resource);

export const privateUrl = (service: string, port: number) => `http://${service}.railway.internal:${port}`;

/**
 * Runs `entry` (e.g. `packages/router/src/main.ts`) from achq at ACHQ_REF.
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
    `  const res = await fetch("https://codeload.github.com/${ACHQ_SOURCE}/tar.gz/" + ref);`,
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

export type RouterServiceInputs = {
  name: string;
  key: string;
  apps: Record<string, { id: string; privateKey: string }>;
  deployerUrl: string;
  ref: string;
};

/** Stable JSON, so the same Apps always make the same variable. */
export const appsVariable = (apps: RouterServiceInputs["apps"]) =>
  JSON.stringify(Object.fromEntries(Object.entries(apps).sort(([a], [b]) => a.localeCompare(b))));

export const routerServiceSpec = (inputs: RouterServiceInputs): ServiceSpec => ({
  name: inputs.name,
  settings: { source: { image: BUN_IMAGE }, startCommand: startCommand("packages/router/src/main.ts"), healthcheckPath: "/", sleepApplication: false },
  variables: {
    [ENV.key]: inputs.key,
    [ENV.githubApps]: appsVariable(inputs.apps),
    [ENV.deployerUrl]: inputs.deployerUrl,
    [ENV.ref]: inputs.ref,
    PORT: String(ROUTER_PUBLIC_PORT),
    [ENV.privatePort]: String(ROUTER_PRIVATE_PORT),
  },
  volume: "/data",
  publicPort: ROUTER_PUBLIC_PORT,
  redeploy: true,
});

export type DeployerServiceInputs = {
  name: string;
  key: string;
  routerUrl: string;
  /** Unknown until the router has a domain, on the first `up`. */
  routerPublicUrl?: string;
  owners: string[];
  railwayToken: string;
  projectId: string;
  environmentId: string;
  claudeToken: string;
  ref: string;
};

export const deployerServiceSpec = (inputs: DeployerServiceInputs): ServiceSpec => ({
  name: inputs.name,
  settings: { source: { image: BUN_IMAGE }, startCommand: startCommand("packages/deployer/src/main.ts"), healthcheckPath: "/", sleepApplication: true },
  variables: {
    [ENV.key]: inputs.key,
    [ENV.routerUrl]: inputs.routerUrl,
    ...(inputs.routerPublicUrl && { [ENV.routerPublicUrl]: inputs.routerPublicUrl }),
    [ENV.owners]: inputs.owners.join(","),
    RAILWAY_API_TOKEN: inputs.railwayToken,
    ACHQ_RAILWAY_PROJECT_ID: inputs.projectId,
    ACHQ_RAILWAY_ENVIRONMENT_ID: inputs.environmentId,
    [ENV.claudeToken]: inputs.claudeToken,
    [ENV.ref]: inputs.ref,
    PORT: String(DEPLOYER_PORT),
  },
  volume: "/data",
  redeploy: true,
});
