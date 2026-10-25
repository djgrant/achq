import { all, GENERATED, type Input, type Output } from "../engine/values.ts";
import { DEPLOYER_PORT, ENV, ROUTER_PRIVATE_PORT, ROUTER_PUBLIC_PORT } from "../wire/constants.ts";
import { type Context, declared, Resource, resetDeclarations } from "./resource.ts";
import { CurrentVariables, type VariableGroup, VariableGroups, type VariableValues } from "./variables.ts";

/** A variable's value: a string, another resource's output, or generated once and then kept. */
export type EnvValue = Input<string> | typeof GENERATED;
export type EnvValues = Record<string, EnvValue>;

/**
 * Where one of achq's services runs, as its container provider makes it:
 * all a plugin gives a `Service`, which keeps its variables itself.
 */
export interface Placement {
  /** Its name there, e.g. `achq-router`: names it in errors. */
  readonly name: string;
  /** Where it keeps what it stores, as ACHQ_DATA_DIR. */
  readonly dataDir: string;
  /** The URL the other services reach it on at `port`. Known before it exists. */
  privateUrl(port: number): string;
  /** Makes the resource that sets a group of its variables, named `name`. */
  group(name: string, values: EnvValues): VariableGroup<any>;
  /**
   * What it's made of, `groups` among them, and its deploy over `variables`:
   * every group's variables as one map. Called once, when it's planned.
   */
  resources(groups: VariableGroup<any>[], variables: Output<Record<string, string>>): Resource[];
}

/** The router or the deployer: one of achq's services, on its container provider. */
export abstract class Service extends Resource {
  /** The `ContainerProvider` it runs on, by id. */
  abstract readonly containerProvider: string;
  /** The file in achq it runs, e.g. `packages/service-router/src/main.ts`. */
  abstract readonly entry: string;
  /** A public service gets a public URL for this port. */
  abstract readonly port: number;
  abstract readonly public: boolean;
  /** Sleeps when idle, and wakes on a request. */
  abstract readonly sleeps: boolean;
  /** Where it runs: set by its plugin's constructor. */
  protected abstract readonly placement: Placement;

  /** Its groups of variables, made when they're first asked for: by then its placement is set. */
  private ownGroups?: VariableGroups<VariableGroup<any>>;
  private made?: Resource[];

  /** What achq itself puts at the start of its first group. */
  protected achqVariables(): EnvValues {
    return {};
  }

  /** Its container provider's own variables, e.g. a token: in its first group, after `achqVariables`. Called when it's planned. */
  protected providerVariables(_ctx: Context): EnvValues {
    return {};
  }

  private get variableGroups() {
    const { placement } = this;
    // What every service has, in its first group: where it keeps what it stores, and the port it listens on.
    return (this.ownGroups ??= new VariableGroups(placement.name, (name, values) => placement.group(name, values), (ctx) => ({
      ...this.achqVariables(),
      ...this.providerVariables(ctx),
      [ENV.dataDir]: placement.dataDir,
      PORT: String(this.port),
    })));
  }

  /** Its first group of variables: what every service has. */
  protected get first() {
    return this.variableGroups.first;
  }

  /** The URL the other services reach it on at `port`. Known before it exists. */
  privateUrl(port: number) {
    return this.placement.privateUrl(port);
  }

  /**
   * Declares a group of its variables, set as one resource. A later group can
   * take values from resources that depend on an earlier one: the router's
   * key → a GitHub App → the App's key on the router. A function is called
   * when the service is planned, so it can take from resources declared after.
   * It's redeployed whenever its settings or any of its variables change.
   */
  variables(values: VariableValues): Output<Record<string, string>> {
    return this.variableGroups.add(values).outputs();
  }

  /** Whether it's been planned, so no group of variables can be declared. */
  protected get planned() {
    return this.made !== undefined;
  }

  /** Made once, when it's planned: no group of variables can be declared after. */
  children(ctx: Context): Resource[] {
    if (this.made) return this.made;
    // Deployed over every group's variables as one map, as it was before variables came in groups.
    const { groups, variables } = this.variableGroups.resolve(ctx);
    return (this.made = this.placement.resources(groups, variables));
  }
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
  private current?: CurrentVariables;
  /** What's added to each variable many resources add to, by key, by the variable's name. */
  private readonly added = new Map<string, Map<string, Output<unknown>>>();

  /** AGENT_WEBHOOK_KEY, generated once, in its first group of variables: known only once it's set, so a known key means the router exists. */
  get key(): Output<string> {
    return this.first.out(ENV.key);
  }

  /** Read whenever it's planned, whether or not anything takes `env`. */
  private get currentVariables() {
    return (this.current ??= new CurrentVariables("env", this.first, { parent: this }));
  }

  /** Its variables as they are before this run changes them: empty if it doesn't exist yet. */
  get env(): Output<Record<string, string>> {
    return this.currentVariables.outputs();
  }

  /**
   * Adds `value`, under `key`, to its variable `name`, which many resources
   * add to: e.g. each GitHub channel adds its App's key, by slug, to
   * ACHQ_GITHUB_APPS. When it's planned, `join` makes the variable from its
   * value as stored and everything added, by key: the first to add gives it. A
   * key is added once.
   */
  addTo<T>(name: string, key: string, value: Output<T>, join: (stored: string | undefined, added: Record<string, T>) => string) {
    if (this.planned) throw new Error(`${this.name}: ${name} added to after it was planned`);
    let added = this.added.get(name);
    if (!added) {
      const values = (added = new Map());
      this.added.set(name, values);
      // Valued when it's planned, once everything that adds to it has.
      this.variables(() => ({
        [name]: all([this.env, all([...values.values()])]).map(([env, made]) => join(env[name], Object.fromEntries([...values.keys()].map((k, i) => [k, made[i] as T])))),
      }));
    }
    if (added.has(key)) throw new Error(`${this.name}: ${key} adds to ${name} twice`);
    added.set(key, value);
  }

  /** Its variables as they are come first, so they're read before any group is set, even when this run makes it. */
  children(ctx: Context): Resource[] {
    return [this.currentVariables, ...super.children(ctx)];
  }

  protected achqVariables(): EnvValues {
    return { [ENV.key]: GENERATED };
  }
}

/** Evaluates repo config and deploys its containers, on its container provider. */
export abstract class Deployer extends Service {
  readonly kind = "deployer";
  readonly entry = "packages/service-deployer/src/main.ts";
  readonly port = DEPLOYER_PORT;
  readonly public = false;
  readonly sleeps = true;
  abstract readonly inputs: { router: Router; owners: string[] };

  /**
   * Has the next apply replace the token the deployer reaches its container
   * provider with, where it has one of its own rather than a copy of yours:
   * `achq infra up --rotate-deployer-token`. Cloudflare's has its own. Railway's
   * gets yours on every run, so it has nothing to replace.
   */
  rotateToken(): void {}

  /**
   * Gives its router and it what achq itself does: how they reach each other,
   * what they run (`ref`, an achq commit), and what every container gets
   * (`containerEnv`). `achq infra up` calls it once the infra is declared.
   */
  connect({ ref, containerEnv }: { ref: string; containerEnv: Record<string, string> }) {
    const { router, owners } = this.inputs;
    router.variables({
      [ENV.deployerUrl]: this.privateUrl(DEPLOYER_PORT),
      [ENV.ref]: ref,
      // Where it keeps what it stores: its container provider's store.
      [ENV.containerProvider]: router.containerProvider,
    });
    this.variables({
      [ENV.key]: router.key,
      [ENV.routerUrl]: router.privateUrl(ROUTER_PRIVATE_PORT),
      [ENV.routerPublicUrl]: router.url,
      [ENV.owners]: owners.join(","),
      [ENV.containerEnv]: JSON.stringify(containerEnv),
      [ENV.ref]: ref,
      [ENV.containerProvider]: this.containerProvider,
    });
  }
}

export type Infra = { resources: Resource[] };

/** The ACHQ infra: `export default achq(() => { … })`. Declares its resources when `achq infra up` calls it. */
export const achq = (declare: () => void) => () => {
  resetDeclarations();
  declare();
  return { resources: declared() } satisfies Infra;
};
