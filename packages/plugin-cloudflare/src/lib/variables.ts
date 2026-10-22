import { type Change, type Context, GENERATED, known, ManagedResource, type Planned, UNKNOWN } from "@achq/core";
import { collections } from "@achq/utils/collections";
import { cloudflareFromEnv } from "./cloudflare.ts";

type Declared = Record<string, string | typeof GENERATED>;
/** `key` is where they're kept in the project's namespace; `target` names them in a plan. */
type Props = { namespaceId: string; key: string; target: string; values: Declared };
type Current = Record<string, string>;
/** The variables to set. Unknown values differ from anything. */
type Set = Record<string, string>;

/** Each declared variable's value once `set` is set over `current`: undefined for one in neither. */
const valuesAfter = (values: Declared, current: Current, set: Set = {}): Record<string, string | undefined> =>
  collections.mapValues(values, (_, key) => set[key] ?? current[key]);

/** Reads a Worker's variables, as JSON in the project's namespace: none until it has some. */
export const readVariables = async (ctx: Context, namespaceId: string, key: string): Promise<Current> => {
  const stored = await cloudflareFromEnv(ctx.env).kv.get(namespaceId, key);
  return stored ? JSON.parse(stored) : {};
};

/**
 * A group of a Worker's variables, kept readable in the project's KV
 * namespace: Worker secrets can't be read back, and a service's variables and
 * generated keys have to be. What runs gets them as secrets when it's deployed.
 */
export class Variables extends ManagedResource<Props, Current, Current, Set> {
  readonly kind = "cloudflare-variables";

  async read({ namespaceId, key }: Props, ctx: Context) {
    return known(namespaceId) ? readVariables(ctx, namespaceId, key) : undefined;
  }

  diff({ values }: Props, current: Current = {}, ctx: Context): Set[] {
    // A generated value is made here, once, so what's printed is what's set: as `current` has it, or else a new secret.
    const want = collections.mapValues(values, (value, key) => (value === GENERATED ? (current[key] ?? ctx.newSecret()) : value));
    // Variables not declared here are left alone.
    const set = collections.filterKeys(want, (key) => current[key] !== want[key]);
    return Object.keys(set).length ? [set] : [];
  }

  describe(set: Set, { target }: Props): Change {
    return { op: "~", target, what: "variables", names: Object.keys(set) };
  }

  planned({ values }: Props, current: Current = {}, changes: Set[]): Planned<Current> {
    return collections.mapValues(valuesAfter(values, current, changes[0]), (value) => value ?? UNKNOWN);
  }

  async apply({ namespaceId, key, values }: Props, current: Current = {}, [set]: Set[], ctx: Context) {
    // Several groups share the one record, so it's read again and merged.
    const stored = await readVariables(ctx, namespaceId, key);
    await cloudflareFromEnv(ctx.env).kv.put(namespaceId, key, JSON.stringify({ ...stored, ...set }));
    // Every declared variable is either set now or already was.
    return valuesAfter(values, current, set) as Current;
  }
}
