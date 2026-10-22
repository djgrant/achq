import { type Change, type Context, GENERATED, known, ManagedResource, type Planned, UNKNOWN } from "@achq/core";
import { collections } from "@achq/utils/collections";
import type { ServiceAt } from "@achq/utils/railway";
import { serviceAt } from "./railway.ts";

type Declared = Record<string, string | typeof GENERATED>;
type Props = { at: ServiceAt; service: string; values: Declared };
type Current = Record<string, string>;
/** The variables to set. Unknown values differ from anything. */
type Set = Record<string, string>;

/** Each declared variable's value once `set` is set over `current`: undefined for one in neither. */
const valuesAfter = (values: Declared, current: Current, set: Set = {}): Record<string, string | undefined> =>
  collections.mapValues(values, (_, key) => set[key] ?? current[key]);

export class Variables extends ManagedResource<Props, Current, Current, Set> {
  readonly kind = "railway-variables";

  async read({ at }: Props, ctx: Context) {
    return known(at.serviceId) ? serviceAt(ctx.env, at).variables() : undefined;
  }

  diff({ values }: Props, current: Current = {}, ctx: Context): Set[] {
    // A generated value is made here, once, so what's printed is what's set: as `current` has it, or else a new secret.
    const want = collections.mapValues(values, (value, key) => (value === GENERATED ? (current[key] ?? ctx.newSecret()) : value));
    // Extra variables on the service are left alone.
    const set = collections.filterKeys(want, (key) => current[key] !== want[key]);
    return Object.keys(set).length ? [set] : [];
  }

  describe(set: Set, { service }: Props): Change {
    return { op: "~", target: service, detail: `variables ${Object.keys(set).join(", ")}` };
  }

  planned({ values }: Props, current: Current = {}, changes: Set[]): Planned<Current> {
    return collections.mapValues(valuesAfter(values, current, changes[0]), (value) => value ?? UNKNOWN);
  }

  async apply({ at, values }: Props, current: Current = {}, [set]: Set[], ctx: Context) {
    await serviceAt(ctx.env, at).setVariables(set!);
    // Every declared variable is either set now or already was.
    return valuesAfter(values, current, set) as Current;
  }
}
