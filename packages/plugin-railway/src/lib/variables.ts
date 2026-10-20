import { type Change, type Context, GENERATED, known, ManagedResource, type Planned, UNKNOWN } from "@achq/core";
import { filterKeys, mapValues } from "@achq/utils/collections";
import type { At } from "./project.ts";
import { serviceAt } from "./railway.ts";

type Declared = Record<string, string | typeof GENERATED>;
type Props = { at: At & { serviceId: string }; service: string; values: Declared };
type Current = Record<string, string>;
/** The variables to set. Unknown values differ from anything. */
type Set = Record<string, string>;

/** The variables to set: missing or different. Extra variables on the service are left alone. */
export const variablesDiff = (want: Record<string, string>, have: Record<string, string>) => Object.keys(want).filter((key) => have[key] !== want[key]);

/** `values` with each GENERATED one made: as `current` has it, or else a new secret. */
const resolveGenerated = (values: Declared, current: Current, newSecret: () => string): Record<string, string> =>
  mapValues(values, (value, key) => (value === GENERATED ? (current[key] ?? newSecret()) : value));

/** Each declared variable's value once `set` is set over `current`: undefined for one in neither. */
const valuesAfter = (values: Declared, current: Current, set: Set = {}): Record<string, string | undefined> =>
  mapValues(values, (_, key) => set[key] ?? current[key]);

/** A group of the variables achq sets on a service. */
export class Variables extends ManagedResource<Props, Current, Current, Set> {
  readonly kind = "railway-variables";

  async read({ at }: Props, ctx: Context) {
    return known(at.serviceId) ? serviceAt(ctx.env, at).variables() : undefined;
  }

  diff({ values }: Props, current: Current = {}, ctx: Context): Set[] {
    // A generated value is made here, once, so what's printed is what's set.
    const want = resolveGenerated(values, current, ctx.newSecret);
    const differ = variablesDiff(want, current);
    return differ.length ? [filterKeys(want, (key) => differ.includes(key))] : [];
  }

  describe(set: Set, { service }: Props): Change {
    return { op: "~", target: `${service} variables`, detail: Object.keys(set).join(", ") };
  }

  planned({ values }: Props, current: Current = {}, changes: Set[]): Planned<Current> {
    return mapValues(valuesAfter(values, current, changes[0]), (value) => value ?? UNKNOWN);
  }

  async apply({ at, values }: Props, current: Current = {}, [set]: Set[], ctx: Context) {
    await serviceAt(ctx.env, at).setVariables(set!);
    // Every declared variable is either set now or already was.
    return valuesAfter(values, current, set) as Current;
  }
}
