import { CONTAINER_PORT, type ContainerSpec, DEPLOYER_PORT, ENV, ROUTER_PRIVATE_PORT, ROUTER_PUBLIC_PORT } from "@achq/core";
import { BRANCH, BUN_IMAGE, VOLUME } from "../constants.ts";
import { containerServiceName } from "./names.ts";
import type { ServiceSpec } from "./plan.ts";
import { startCommand } from "./start-command.ts";

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
  volume: VOLUME,
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
  volume: VOLUME,
  redeploy: true,
});

/** One Railway service per repo and container: private, sleeping when idle. The deployer starts their builds. */
export const containerServiceSpec = (spec: ContainerSpec): ServiceSpec => ({
  name: containerServiceName(spec.repo, spec.name),
  settings: {
    // Setting a Dockerfile path is what makes Railway build with Docker.
    dockerfilePath: spec.dockerfile,
    healthcheckPath: "/",
    // Sleeps when idle; the router wakes it over the private network.
    sleepApplication: true,
  },
  variables: {
    ...spec.env,
    [ENV.repo]: spec.repo,
    [ENV.container]: spec.name,
    [BRANCH]: spec.branch,
    PORT: String(CONTAINER_PORT),
  },
  volume: VOLUME,
});
