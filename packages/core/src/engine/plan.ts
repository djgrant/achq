// `plan` reads and compares every managed resource in dependency order and
// changes nothing. `apply` applies what differs, reading and comparing a
// resource again first if its inputs changed since.
import { type Context, ManagedResource, type Resource } from "../resources/resource.ts";
import { reachable, topoSort } from "@achq/utils/collections";
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

/** Reads `resource` and compares it with `props`: what it is, what would change, and what it'd give. */
const readAndCompare = async (resource: ManagedResource, props: unknown, ctx: Context): Promise<Step> => {
  const current = await resource.read(props, ctx);
  const changes = resource.diff(props, current, ctx);
  return { props, current, changes, planned: resource.planned(props, current, changes) };
};

type PlannedStep = { resource: ManagedResource; step: Step };

const describeChanges = ({ resource, step }: PlannedStep) => step.changes.map((c) => resource.describe(c, step.props));

/** What achq can't change itself, for a resource that exists. */
const warningsOf = ({ resource, step: { props, current } }: PlannedStep) => (current !== undefined && resource.check ? resource.check(props, current) : []);

/** Plans `resources`, their children and everything they depend on. Reads, never writes. */
export const plan = async (resources: Resource[], ctx: Context): Promise<Plan> => {
  const order = sorted(managed(resources, ctx));
  const outputs: Outputs = new Map();
  const steps: PlannedStep[] = [];
  for (const resource of order) {
    const step = await readAndCompare(resource, resolve(resource.props, outputs), ctx);
    steps.push({ resource, step });
    outputs.set(resource, step.planned);
  }

  return {
    changes: steps.flatMap(describeChanges),
    warnings: steps.flatMap(warningsOf),
    value: (input) => resolve(input, outputs),
    apply: () => applyPlan(steps, ctx),
  };
};

/** Applies each planned step in order, as what it depends on is applied. */
const applyPlan = async (steps: PlannedStep[], ctx: Context): Promise<Applied> => {
  const live: Outputs = new Map();
  const changed = new Set<ManagedResource>();
  for (const planned of steps) {
    const { resource } = planned;
    const props = resolve(resource.props, live);
    assertKnown(resource, props, live);
    const step = await replanIfChanged(planned, props, ctx);
    live.set(resource, await applyStep(resource, props, step, ctx));
    if (step.changes.length) changed.add(resource);
  }
  return { value: (input) => resolve(input, live), changed: (r) => changed.has(r) };
};

/** Once what a resource depends on is applied, its props have to be known. Throws naming the dependencies that aren't. */
const assertKnown = (resource: ManagedResource, props: unknown, live: Outputs) => {
  if (!hasUnknown(props)) return;
  const vague = dependencies(resource.props).filter((d) => hasUnknown(live.get(d))).map(label);
  throw new Error(`${label(resource)}: an input is still unknown after applying what it depends on (${vague.join(", ")})`);
};

/** The planned step, or a fresh one if applying what the resource depends on changed its props. */
const replanIfChanged = async ({ resource, step: planned }: PlannedStep, props: unknown, ctx: Context): Promise<Step> =>
  same(props, planned.props) ? planned : readAndCompare(resource, props, ctx);

/** Makes the step's changes, if it has any. The resource's outputs either way. */
const applyStep = async (resource: ManagedResource, props: unknown, { current, changes, planned }: Step, ctx: Context): Promise<unknown> =>
  changes.length ? resource.apply(props, current, changes, ctx) : planned;

/** For errors: e.g. `router/variables`. */
const label = (r: Resource): string => (r.parent ? `${label(r.parent)}/${r.name}` : r.name);

/** What a resource has to be planned after: what its props take from, and what it's told to follow. */
const dependsOn = (r: ManagedResource): ManagedResource[] => [...dependencies(r.props), ...r.after];

/** What planning a resource takes in: what a managed one depends on, and any resource's children. */
const plannedWith = (r: Resource, ctx: Context): Resource[] => [...(r instanceof ManagedResource ? dependsOn(r) : []), ...r.children(ctx)];

/**
 * The managed resources among `resources`, their children and what they
 * depend on, in the order found. Each resource's children are asked for once.
 */
const managed = (resources: Resource[], ctx: Context) =>
  reachable(resources, (r) => plannedWith(r, ctx)).filter((r): r is ManagedResource => r instanceof ManagedResource);

/** `resources` and what they depend on, each after its dependencies, otherwise in the order given. Throws on a cycle. */
const sorted = (resources: ManagedResource[]) => topoSort(resources, dependsOn, label);
