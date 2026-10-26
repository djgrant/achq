import { graph } from "@achq/utils/graph";
import { json } from "@achq/utils/json";
import { type Context, isManaged, isReadable, type ManagedResource, type ReadableResource, type Resource } from "../resources/resource.ts";
import { dependencies, hasUnknown, type Input, type Outputs, resolve, type Unknown } from "./values.ts";

/**
 * A planned change, for printing: its target, e.g. a service; what of it, e.g.
 * the service or its volume; and any detail, or the names of what it changes,
 * e.g. variables, never their values.
 */
export type Change = { op: "+" | "~" | "-"; target: string; what: string; detail?: string; names?: string[] };

export type Plan = {
  changes: Change[];
  warnings: string[];
  value<T>(input: Input<T>): T | Unknown;
  apply(): Promise<Applied>;
};

export type Applied = {
  value<T>(input: Input<T>): T;
  changed(resource: ManagedResource): boolean;
};

type Step = { resource: ReadableResource; props: unknown; current: unknown; changes: unknown[]; planned: unknown };

const label = (r: Resource): string => (r.parent ? `${label(r.parent)}/${r.name}` : r.name);

const dependsOn = (r: ReadableResource) => [...dependencies(r.props), ...r.after];

/** What `resource` is now, and what applying `props` would change: nothing, for a data source. */
const readAndCompare = async (resource: ReadableResource, props: unknown, ctx: Context): Promise<Step> => {
  const current = await resource.read(props, ctx);
  if (!isManaged(resource)) return { resource, props, current, changes: [], planned: current };
  const changes = resource.diff(props, current, ctx);
  return { resource, props, current, changes, planned: resource.planned(props, current, changes) };
};

/** The steps of what achq keeps in shape: not data sources. */
const managed = (steps: Step[]) => steps.filter((s): s is Step & { resource: ManagedResource } => isManaged(s.resource));

/** Reads `resources`, their children and everything they depend on, each after what it depends on. */
const readAll = async (resources: Resource[], ctx: Context) => {
  // Each resource's children are asked for once.
  const reached = graph.reachable(resources, (r) => [...(isReadable(r) ? dependsOn(r) : []), ...r.children(ctx)]);
  const outputs: Outputs = new Map();
  const steps: Step[] = [];
  for (const resource of graph.topoSort(reached.filter(isReadable), dependsOn, label)) {
    const step = await readAndCompare(resource, resolve(resource.props, outputs), ctx);
    steps.push(step);
    outputs.set(resource, step.planned);
  }
  return { steps, outputs };
};

/** Plans `resources`, their children and everything they depend on. Reads, never writes. */
export const plan = async (resources: Resource[], ctx: Context): Promise<Plan> => {
  const { steps, outputs } = await readAll(resources, ctx);

  return {
    changes: steps.flatMap(({ resource, props, changes }) => changes.map((c) => (resource as ManagedResource).describe(c, props))),
    warnings: managed(steps).flatMap(({ resource, props, current }) => (current !== undefined && resource.check ? resource.check(props, current) : [])),
    value: (input) => resolve(input, outputs),
    apply: async () => {
      const live: Outputs = new Map();
      const changed = new Set<ManagedResource>();
      for (const planned of steps) {
        const { resource } = planned;
        const props = resolve(resource.props, live);
        // Once what a resource depends on is applied, its props have to be known.
        if (hasUnknown(props)) {
          const vague = dependencies(resource.props).filter((d) => hasUnknown(live.get(d))).map(label);
          throw new Error(`${label(resource)}: an input is still unknown after applying what it depends on (${vague.join(", ")})`);
        }
        // Applying what it depends on can change its props, and so what it has to change.
        const step = json.deepEqual(props, planned.props) ? planned : await readAndCompare(resource, props, ctx);
        live.set(resource, step.changes.length ? await (resource as ManagedResource).apply(props, step.current, step.changes, ctx) : step.planned);
        if (step.changes.length) changed.add(resource as ManagedResource);
      }
      return { value: (input) => resolve(input, live), changed: (r) => changed.has(r) };
    },
  };
};

export type Teardown = {
  /** What it deletes, in order. */
  changes: Change[];
  /** What it leaves because it's protected, and where you delete each yourself, if it says. */
  protected: { target: string; what: string; page?: string }[];
  apply(): Promise<void>;
};

/** Plans deleting `resources`, their children and everything they depend on that exists: each before what it depends on. Reads, never writes. */
export const teardown = async (resources: Resource[], ctx: Context): Promise<Teardown> => {
  const existing = managed((await readAll(resources, ctx)).steps).filter((s) => s.current !== undefined).reverse();
  const doomed = existing.filter(({ resource }) => !resource.protect && resource.destroy);
  return {
    changes: doomed.map(({ resource }) => ({ op: "-" as const, target: label(resource), what: resource.kind })),
    protected: existing
      .filter(({ resource }) => resource.protect)
      .map(({ resource, props, current }) => ({ target: label(resource), what: resource.kind, ...(resource.deletePage && { page: resource.deletePage(props, current, ctx) }) })),
    apply: async () => {
      for (const { resource, props, current } of doomed) await resource.destroy!(props, current, ctx);
    },
  };
};
