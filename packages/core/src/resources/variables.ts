import { collections } from "@achq/utils/collections";
import type { Change } from "../engine/plan.ts";
import { all, GENERATED, type Output, type Planned, UNKNOWN } from "../engine/values.ts";
import type { EnvValues } from "./infra.ts";
import { type Context, DataSource, ManagedResource, type ResourceOptions } from "./resource.ts";
import { PLUGIN } from "../plugin.ts";

/** A group's variables as its props have them: GENERATED ones are made when they're first set. */
export type DeclaredVariables = Record<string, string | typeof GENERATED>;
type Current = Record<string, string>;
/** The variables to set: GENERATED for one made as it's set. Unknown values differ from anything. */
type Set = Record<string, string | typeof GENERATED>;

/** Each declared variable's value once `set` is set over `current`: undefined for one in neither. */
const valuesAfter = (values: DeclaredVariables, current: Current, set: Set = {}) => collections.mapValues(values, (_, key) => set[key] ?? current[key]);

/**
 * A group of a service's variables, set as one resource. Its provider says
 * where they're kept: `read` reads them all, `store` sets some, and `target`
 * names them in a plan. Variables kept there but not declared are left alone.
 */
export abstract class VariableGroup<P extends { values: DeclaredVariables }> extends ManagedResource<P, Current, Current, Set> {
  /** Sets `set` over what's kept, leaving the rest. */
  protected abstract store(props: P, set: Set, ctx: Context): Promise<void>;
  protected abstract target(props: P): string;

  diff({ values }: P, current: Current = {}): Set[] {
    // A generated value is kept once it's set.
    const set = collections.filterKeys(values, (key) => (values[key] === GENERATED ? current[key] === undefined : current[key] !== values[key]));
    return Object.keys(set).length ? [set] : [];
  }

  describe(set: Set, props: P): Change {
    return { op: "~", target: this.target(props), what: "variables", names: Object.keys(set) };
  }

  /** A generated value is unknown until it's set: so a known one is kept where the service's variables are. */
  planned({ values }: P, current: Current = {}, changes: Set[]): Planned<Current> {
    return collections.mapValues(valuesAfter(values, current, changes[0]), (value) => (value === undefined || value === GENERATED ? UNKNOWN : value));
  }

  async apply(props: P, current: Current = {}, [set]: Set[], ctx: Context) {
    const made = collections.mapValues(set!, (value) => (value === GENERATED ? ctx.newSecret() : value));
    await this.store(props, made, ctx);
    // Every declared variable is either set now or already was.
    return valuesAfter(props.values, current, made) as Current;
  }
}

/**
 * A service's variables as `group`'s provider keeps them, all of them, before
 * this run sets any: none if it doesn't exist yet. Read with the group's props
 * but not its values, so it depends only on where they're kept.
 */
export class CurrentVariables extends DataSource<object, Current> {
  readonly plugin = PLUGIN;
  readonly kind = "current-variables";

  constructor(
    name: string,
    private readonly group: VariableGroup<any>,
    options: ResourceOptions,
  ) {
    super(name, { ...(group.props as object), values: {} }, options);
  }

  async read(props: object, ctx: Context): Promise<Current> {
    return (await this.group.read(props, ctx)) ?? {};
  }
}

/** A group of variables, or how to make them when it's planned. */
export type VariableValues = EnvValues | ((ctx: Context) => EnvValues);

/**
 * A service's groups of variables: `make` makes each one's resource, named
 * `variables`, `variables-2`, …, from the values it sets. A group declared
 * with a function gets its values when it's resolved, so it can take what only
 * planning has, e.g. a token from your environment, or what's declared after
 * it. The first is `first`'s. Resolved once, when the service is planned: no
 * group can be declared after.
 */
export class VariableGroups<V extends VariableGroup<any>> {
  /** Each group's resource, the values it sets, and, if declared with a function, how they're filled in when resolved. */
  private readonly groups: { variables: V; values: EnvValues; fill?: (ctx: Context) => EnvValues }[] = [];
  private resolved = false;
  readonly first: V;

  constructor(
    /** Names the service in errors. */
    private readonly service: string,
    private readonly make: (name: string, values: EnvValues) => V,
    first: (ctx: Context) => EnvValues,
  ) {
    this.first = this.add(first);
  }

  add(declared: VariableValues) {
    if (this.resolved) throw new Error(`${this.service}: variables declared after it was planned`);
    const n = this.groups.length;
    const values = typeof declared === "function" ? {} : declared;
    const variables = this.make(n ? `variables-${n + 1}` : "variables", values);
    this.groups.push({ variables, values, ...(typeof declared === "function" && { fill: declared }) });
    return variables;
  }

  /** Every group's resource, and their variables as one map. */
  resolve(ctx: Context): { groups: V[]; variables: Output<Record<string, string>> } {
    for (const { values, fill } of this.groups) if (fill) Object.assign(values, fill(ctx));
    // Two groups setting one variable would undo each other on every apply.
    const shared = collections.duplicates(this.groups.flatMap(({ values }) => Object.keys(values)));
    if (shared.length) throw new Error(`${this.service}: ${shared.join(", ")} declared in two groups of variables`);
    const groups = this.groups.map((g) => g.variables);
    const variables = all(groups.map((g) => g.outputs())).map((maps): Record<string, string> => Object.assign({}, ...maps));
    this.resolved = true;
    return { groups, variables };
  }
}
