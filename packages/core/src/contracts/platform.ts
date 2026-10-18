import type { Deployer, Router } from "../model/infra.ts";
import type { ContainerHost } from "./host.ts";

type Env = Record<string, string | undefined>;

/** A planned change, for printing. Variable changes name the variables, never their values. */
export type Change = { op: "+" | "~" | "-"; target: string; detail?: string };

/** The router or the deployer, as `achq up` asks a platform to run it. */
export type ServiceDefinition = {
  /** The resource's name. The platform derives its own service name from it. */
  name: string;
  /** The file in achq it runs, e.g. `packages/router/src/main.ts`. */
  entry: string;
  env: Record<string, string>;
  /** The port it listens on. A public service gets a public URL for this port. */
  port: number;
  public: boolean;
  /** Sleeps when idle, and wakes on a request. */
  sleeps: boolean;
};

export type ServicePlan = {
  /** The service's name on the platform, for printing. */
  service: string;
  changes: Change[];
  /** Its public URL as it is now. */
  publicUrl?: string;
  apply(): Promise<{ publicUrl?: string; deployed: boolean }>;
};

/** Where the infra's router and deployer run, for `achq up` and `achq status`. */
export interface InfraPlatform {
  /** Creates what the services live in (e.g. a project), unless it's a dry run. Returns what that changes. */
  prepare(dryRun: boolean): Promise<Change[]>;
  /** The URL the other services reach `name` on. Known before it exists. */
  privateUrl(name: string, port: number): string;
  /** A service's env and public URL as it runs now, or undefined if it doesn't exist. */
  current(name: string): Promise<{ env: Record<string, string>; publicUrl?: string } | undefined>;
  plan(service: ServiceDefinition): Promise<ServicePlan>;
  /** Waits for the service's latest deploy to go live. */
  waitForDeploy(name: string): Promise<void>;
  /** What the deployer needs in its env for `Platform.containerHost`. */
  containerHostEnv(): Record<string, string>;
}

/** A container at a location its host's `locate` gave, for `achq ssh` and `achq resume`. */
export interface ContainerShell {
  /** Whether the location has what `open` and `run` need. */
  reachable(location: Record<string, string>): boolean;
  /** A shell in the container, interactive or running `command`. Returns the exit code. */
  open(location: Record<string, string>, command: string[]): Promise<number>;
  /** Runs `command` in the container and returns its stdout. */
  run(location: Record<string, string>, command: string[]): Promise<string>;
}

/** Everything achq needs from a hosting platform. The infra's router and deployer name theirs. */
export interface Platform {
  readonly id: string;
  /** Throws if the router and deployer aren't this platform's, or can't run together. */
  infra(resources: { router: Router; deployer: Deployer }, env: Env): InfraPlatform;
  /** The deployer's container host, from the env `InfraPlatform.containerHostEnv` gave it. */
  containerHost(env: Env): ContainerHost;
  shell: ContainerShell;
}
