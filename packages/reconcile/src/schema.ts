// The vocabulary follows @notation/resource's, so moving onto Notation later
// is a rename rather than a rethink.

/** How one of a resource's params takes part in a diff. */
export type Field =
  /** Identifies the resource: `read` finds it by this. A different key is a different resource, so keys are never compared. */
  | { kind: "key" }
  /** Desired state, compared with what `read` returns. An immutable one can't be changed once the resource exists. */
  | { kind: "param"; immutable?: true };

/**
 * The params a resource compares. Params it leaves out are inputs (clients,
 * other resources' outputs) and are never compared. A param left `undefined`
 * isn't managed. A param that's a plain object is managed entry by entry: the
 * entries it doesn't list are left alone.
 */
export type Schema<P> = { readonly [K in keyof P]?: Field };
