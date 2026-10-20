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
  value<T>(input: Input<T>): T | Unknown;
  apply(): Promise<Applied>;
};

export type Applied = {
  value<T>(input: Input<T>): T;
  changed(resource: ManagedResource): boolean;
};

type Step = { props: unknown; current: unknown; changes: unknown[]; planned: unknown };

const readAndCompare = async (resource: ManagedResource, props: unknown, ctx: Context): Promise<Step> => {
  const current = await resource.read(props, ctx);
  const changes = resource.diff(props, current, ctx);
  return { props, current, changes, planned: resource.planned(props, current, changes) };
};

type PlannedStep = { resource: ManagedResource; step: Step };

const describeChanges = ({ resource, step }: PlannedStep) => step.changes.map((c) => resource.describe(c, step.props));

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

/** Once what a resource depends on is applied, its props have to be known. */
const assertKnown = (resource: ManagedResource, props: unknown, live: Outputs) => {
  if (!hasUnknown(props)) return;
  const vague = dependencies(resource.props).filter((d) => hasUnknown(live.get(d))).map(label);
  throw new Error(`${label(resource)}: an input is still unknown after applying what it depends on (${vague.join(", ")})`);
};

const replanIfChanged = async ({ resource, step: planned }: PlannedStep, props: unknown, ctx: Context): Promise<Step> =>
  same(props, planned.props) ? planned : readAndCompare(resource, props, ctx);

const applyStep = async (resource: ManagedResource, props: unknown, { current, changes, planned }: Step, ctx: Context): Promise<unknown> =>
  changes.length ? resource.apply(props, current, changes, ctx) : planned;

const label = (r: Resource): string => (r.parent ? `${label(r.parent)}/${r.name}` : r.name);

const dependsOn = (r: ManagedResource): ManagedResource[] => [...dependencies(r.props), ...r.after];

const plannedWith = (r: Resource, ctx: Context): Resource[] => [...(r instanceof ManagedResource ? dependsOn(r) : []), ...r.children(ctx)];

/** Each resource's children are asked for once. */
const managed = (resources: Resource[], ctx: Context) =>
  reachable(resources, (r) => plannedWith(r, ctx)).filter((r): r is ManagedResource => r instanceof ManagedResource);

const sorted = (resources: ManagedResource[]) => topoSort(resources, dependsOn, label);
