// `plan` reads and compares every managed resource in dependency order and
// changes nothing. `apply` applies what differs, reading and comparing a
// resource again first if its inputs changed since.
import { type Context, ManagedResource, type Resource } from "../resources/resource.ts";
import { dependencies, hasUnknown, type Input, type Outputs, resolve, same, type Unknown } from "./values.ts";

/** A planned change, for printing. Variable changes name the variables, never their values. */
export type Change = { op: "+" | "~" | "-"; target: string; detail?: string };

export type Plan = {
  changes: Change[];
  warnings: string[];
  /** An input's value as planned. */
  value<T>(input: Input<T>): T | Unknown;
  apply(): Promise<Applied>;
};

export type Applied = {
  value<T>(input: Input<T>): T;
  /** Whether `resource` changed. */
  changed(resource: ManagedResource): boolean;
};

type Step = { props: unknown; current: unknown; changes: unknown[]; planned: unknown };

const step = async (resource: ManagedResource, props: unknown, ctx: Context): Promise<Step> => {
  const current = await resource.read(props, ctx);
  const changes = resource.diff(props, current, ctx);
  return { props, current, changes, planned: resource.planned(props, current, changes) };
};

/** Plans `resources`, their children and everything they depend on. Reads, never writes. */
export const plan = async (resources: Resource[], ctx: Context): Promise<Plan> => {
  const order = sorted(managed(resources, ctx));
  const planned: Outputs = new Map();
  const steps = new Map<ManagedResource, Step>();
  for (const r of order) {
    const s = await step(r, resolve(r.props, planned), ctx);
    steps.set(r, s);
    planned.set(r, s.planned);
  }

  return {
    changes: order.flatMap((r) => steps.get(r)!.changes.map((c) => r.describe(c, steps.get(r)!.props))),
    warnings: order.flatMap((r) => {
      const { props, current } = steps.get(r)!;
      return current !== undefined && r.check ? r.check(props, current) : [];
    }),
    value: (input) => resolve(input, planned),
    async apply() {
      const live: Outputs = new Map();
      const changed = new Set<ManagedResource>();
      for (const r of order) {
        let s = steps.get(r)!;
        const now = resolve(r.props, live);
        if (hasUnknown(now)) {
          const vague = dependencies(r.props).filter((d) => hasUnknown(live.get(d))).map(label);
          throw new Error(`${label(r)}: an input is still unknown after applying what it depends on (${vague.join(", ")})`);
        }
        if (!same(now, s.props)) s = await step(r, now, ctx);
        if (s.changes.length) {
          live.set(r, await r.apply(now, s.current, s.changes, ctx));
          changed.add(r);
        } else live.set(r, s.planned);
      }
      return { value: (input) => resolve(input, live), changed: (r) => changed.has(r) };
    },
  };
};

/** For errors: e.g. `router/variables`. */
const label = (r: Resource): string => (r.parent ? `${label(r.parent)}/${r.name}` : r.name);

/**
 * The managed resources among `resources`, their children and what they
 * depend on, in the order given. Each resource's children are asked for once.
 */
const managed = (resources: Resource[], ctx: Context) => {
  const seen = new Set<Resource>();
  const found: ManagedResource[] = [];
  const visit = (r: Resource) => {
    if (seen.has(r)) return;
    seen.add(r);
    if (r instanceof ManagedResource) {
      found.push(r);
      for (const d of [...dependencies(r.props), ...r.after]) visit(d);
    }
    for (const child of r.children(ctx)) visit(child);
  };
  for (const r of resources) visit(r);
  return found;
};

/** `resources` and what they depend on, each after its dependencies, otherwise in the order given. */
const sorted = (resources: ManagedResource[]) => {
  const order: ManagedResource[] = [];
  const visiting: ManagedResource[] = [];
  const visit = (r: ManagedResource) => {
    if (order.includes(r)) return;
    if (visiting.includes(r)) throw new Error(`A cycle: ${[...visiting.slice(visiting.indexOf(r)), r].map(label).join(" → ")}`);
    visiting.push(r);
    for (const d of [...dependencies(r.props), ...r.after]) visit(d);
    visiting.pop();
    order.push(r);
  };
  for (const r of resources) visit(r);
  return order;
};
