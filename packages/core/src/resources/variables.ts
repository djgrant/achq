import { collections } from "@achq/utils/collections";
import type { Change } from "../engine/plan.ts";
import { all, GENERATED, type Output, type Planned, UNKNOWN } from "../engine/values.ts";
import type { EnvValues } from "./infra.ts";
import { type Context, ManagedResource } from "./resource.ts";

/** A group's variables as its props have them: GENERATED ones are made when it's planned. */
export type DeclaredVariables = Record<string, string | typeof GENERATED>;
type Current = Record<string, string>;
/** The variables to set. Unknown values differ from anything. */
type Set = Record<string, string>;

/** Each declared variable's value once `set` is set over `current`: undefined for one in neither. */
const valuesAfter = (values: DeclaredVariables, current: Current, set: Set = {}): Record<string, string | undefined> =>
  collections.mapValues(values, (_, key) => set[key] ?? current[key]);

/**
 * A group of a service's variables, set as one resource. Its provider says
 * where they're kept: `read` reads them all, `store` sets some, and `target`
 * names them in a plan. Variables kept there but not declared are left alone.
 */
export abstract class VariableGroup<P extends { values: DeclaredVariables }> extends ManagedResource<P, Current, Current, Set> {
  /** Sets `set` over what's kept, leaving the rest. */
  protected abstract store(props: P, set: Set, ctx: Context): Promise<void>;
  protected abstract target(props: P): string;

  diff({ values }: P, current: Current = {}, ctx: Context): Set[] {
    // A generated value is made here, once, so what's printed is what's set: as `current` has it, or else a new secret.
    const want = collections.mapValues(values, (value, key) => (value === GENERATED ? (current[key] ?? ctx.newSecret()) : value));
    const set = collections.filterKeys(want, (key) => current[key] !== want[key]);
    return Object.keys(set).length ? [set] : [];
  }

  describe(set: Set, props: P): Change {
    return { op: "~", target: this.target(props), what: "variables", names: Object.keys(set) };
  }

  planned({ values }: P, current: Current = {}, changes: Set[]): Planned<Current> {
    return collections.mapValues(valuesAfter(values, current, changes[0]), (value) => value ?? UNKNOWN);
  }

  async apply(props: P, current: Current = {}, [set]: Set[], ctx: Context) {
    await this.store(props, set!, ctx);
    // Every declared variable is either set now or already was.
    return valuesAfter(props.values, current, set) as Current;
  }
}

/** A group of variables, or how to make it when it's planned. */
export type VariableValues = EnvValues | ((ctx: Context) => EnvValues);

/**
 * A service's groups of variables: `make` makes each one's resource, named
 * `variables`, `variables-2`, …, from the values it sets. Resolved once, when
 * the service is planned: no group can be declared after.
 */
export class VariableGroups<V extends VariableGroup<any>> {
  /** Each group's resource, what it was declared with, and the values it sets, filled in when resolved if declared with a function. */
  private readonly groups: { variables: V; declared: VariableValues; values: EnvValues }[] = [];
  private resolved = false;

  constructor(
    /** Names the service in errors. */
    private readonly service: string,
    private readonly make: (name: string, values: EnvValues) => V,
  ) {}

  add(declared: VariableValues) {
    if (this.resolved) throw new Error(`${this.service}: variables declared after it was planned`);
    const n = this.groups.length;
    const values = typeof declared === "function" ? {} : declared;
    const variables = this.make(n ? `variables-${n + 1}` : "variables", values);
    this.groups.push({ variables, declared, values });
    return variables;
  }

  /** Every group's resource, and their variables as one map. */
  resolve(ctx: Context): { groups: V[]; variables: Output<Record<string, string>> } {
    for (const group of this.groups) {
      if (typeof group.declared === "function") Object.assign(group.values, group.declared(ctx));
    }
    // Two groups setting one variable would undo each other on every apply.
    const shared = collections.duplicates(this.groups.flatMap(({ values }) => Object.keys(values)));
    if (shared.length) throw new Error(`${this.service}: ${shared.join(", ")} declared in two groups of variables`);
    const groups = this.groups.map((g) => g.variables);
    const variables = all(groups.map((g) => g.outputs())).map((maps): Record<string, string> => Object.assign({}, ...maps));
    this.resolved = true;
    return { groups, variables };
  }
}
