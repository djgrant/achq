import { type Change, type Context, GENERATED, known, ManagedResource, type Planned, UNKNOWN } from "@achq/core";
import { railwayClient } from "../lib/client.ts";
import type { At } from "./project.ts";

type Props = { at: At & { serviceId: string }; service: string; values: Record<string, string | typeof GENERATED> };
type Current = Record<string, string>;
/** The variables to set. Unknown values differ from anything. */
type Set = Record<string, string>;

/** The variables to set: missing or different. Extra variables on the service are left alone. */
export const variablesDiff = (want: Record<string, string>, have: Record<string, string>) => Object.keys(want).filter((key) => have[key] !== want[key]);

/** A group of the variables achq sets on a service. */
export class Variables extends ManagedResource<Props, Current, Current, Set> {
  readonly kind = "railway-variables";

  async read({ at }: Props, ctx: Context) {
    return known(at.serviceId) ? railwayClient(ctx.env).variables(at.projectId, at.environmentId, at.serviceId) : undefined;
  }

  diff({ values }: Props, current: Current = {}, ctx: Context): Set[] {
    // A generated value is made here, once, so what's printed is what's set.
    const want = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v === GENERATED ? (current[k] ?? ctx.newSecret()) : v]));
    const differ = variablesDiff(want, current);
    return differ.length ? [Object.fromEntries(differ.map((k) => [k, want[k]!]))] : [];
  }

  describe(set: Set, { service }: Props): Change {
    return { op: "~", target: `${service} variables`, detail: Object.keys(set).join(", ") };
  }

  planned({ values }: Props, current: Current = {}, changes: Set[]): Planned<Current> {
    return Object.fromEntries(Object.keys(values).map((k) => [k, changes[0]?.[k] ?? current[k] ?? UNKNOWN]));
  }

  async apply({ at, values }: Props, current: Current = {}, [set]: Set[], ctx: Context) {
    await railwayClient(ctx.env).setVariables(at.projectId, at.environmentId, at.serviceId, set!);
    return Object.fromEntries(Object.keys(values).map((k) => [k, set![k] ?? current[k]!]));
  }
}
