// What the ACHQ infra declares. A plugin (railway) subclasses the router and
// deployer with where they run, as resources made of its own.
import { GENERATED, type Input, type Output } from "../engine/values.ts";
import { DEPLOYER_PORT, ROUTER_PUBLIC_PORT } from "../wire/constants.ts";
import { declared, resetDeclarations } from "./declarations.ts";
import { type Context, Resource } from "./resource.ts";

/** A variable's value: a string, another resource's output, or generated once and then kept. */
export type EnvValue = Input<string> | typeof GENERATED;
export type EnvValues = Record<string, EnvValue>;

/** The router or the deployer: one of achq's services, on its container host. */
export abstract class Service extends Resource {
  /** The `ContainerHost` it runs on, by id. */
  abstract readonly containerHost: string;
  /** The file in achq it runs, e.g. `packages/service-router/src/main.ts`. */
  abstract readonly entry: string;
  /** The port it listens on. A public service gets a public URL for this port. */
  abstract readonly port: number;
  abstract readonly public: boolean;
  /** Sleeps when idle, and wakes on a request. */
  abstract readonly sleeps: boolean;

  /** The URL the other services reach it on at `port`. Known before it exists. */
  abstract privateUrl(port: number): string;
  /** Its variables as they are before this run changes them: empty if it doesn't exist yet. */
  abstract readonly env: Output<Record<string, string>>;
  /**
   * Declares a group of its variables, set as one resource. A later group can
   * take values from resources that depend on an earlier one: the router's
   * key → a GitHub App → the App's key on the router. A function is called
   * when the service is planned, so it can take from resources declared after.
   * It's redeployed whenever its settings or any of its variables change.
   */
  abstract variables(values: EnvValues | ((ctx: Context) => EnvValues)): Output<Record<string, string>>;
}

/** Receives, stores, filters and forwards events, and mints credentials. */
export abstract class Router extends Service {
  readonly kind = "router";
  readonly entry = "packages/service-router/src/main.ts";
  readonly port = ROUTER_PUBLIC_PORT;
  readonly public = true;
  readonly sleeps = false;
  /** Its public URL: unknown until it has one. */
  abstract readonly url: Output<string>;
  /** AGENT_WEBHOOK_KEY, generated once, in its first group of variables. */
  abstract readonly key: Output<string>;
}

/** Evaluates repo config and deploys its containers, on its container host. */
export abstract class Deployer extends Service {
  readonly kind = "deployer";
  readonly entry = "packages/service-deployer/src/main.ts";
  readonly port = DEPLOYER_PORT;
  readonly public = false;
  readonly sleeps = true;
  abstract readonly inputs: { router: Router; owners: string[] };
}

export type Infra = { resources: Resource[] };

/** The ACHQ infra: `export default achq(() => { … })`. Declares its resources when `achq up` calls it. */
export const achq = (declare: () => void) => (): Infra => {
  resetDeclarations();
  declare();
  return { resources: declared() };
};
