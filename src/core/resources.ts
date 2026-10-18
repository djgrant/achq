// The resources a repo declares in `.achq/config.ts`, and the plan they turn into.
// No Node or Bun imports: this is bundled into the config sandbox (QuickJS).
import { type Data, toData } from "./data.ts";

/** Selector and policy data always says which channel or provider interprets it. */
export type SelectorData = { channel: string; [key: string]: Data };
export type PolicyData = { provider: string; [key: string]: Data };

/**
 * What a repo's config evaluates to: every resource as plain data. Resources
 * refer to each other by name. Arrays keep declaration order, which decides
 * which workspace claims a thread.
 */
export type RepoPlan = {
  policies: { name: string; policy: PolicyData }[];
  containers: { name: string; image: string; policies: string[]; files: Record<string, Data> }[];
  workspaces: { name: string; container: string; threads: SelectorData; branch: string; base: string }[];
  agents: { name: string; kind: string }[];
  triggers: { name: string; event: SelectorData; agent: string }[];
};

const NAME = /^[a-z][a-z0-9-]{0,30}$/;

let registry: Resource[] = [];

/** Starts a fresh registry, for evaluating another config in the same process. */
export const resetRegistry = () => {
  registry = [];
};

export const registered = () => [...registry];

/** Anything declared in a config. Constructing one registers it. */
export abstract class Resource {
  abstract readonly kind: string;

  constructor(readonly name: string) {
    if (!NAME.test(name)) throw new Error(`Resource name "${name}" must be lowercase letters, digits and dashes, starting with a letter`);
    registry.push(this);
  }
}

/** Which events start a run. Plain data, matched in the router and the container. */
export class EventSelector {
  constructor(readonly data: SelectorData) {
    toData(data, "event selector");
  }
}

/** Which threads a workspace claims. Plain data, matched in the router and the container. */
export class ThreadSelector {
  constructor(readonly data: SelectorData) {
    toData(data, "thread selector");
  }
}

/** What a container can access. Interpreted by its provider. */
export class Policy extends Resource {
  readonly kind = "policy";
  constructor(
    name: string,
    readonly policy: PolicyData,
  ) {
    super(name);
    toData(policy, `policy ${name}`);
  }
}

export type ContainerInputs = {
  /** A Dockerfile, relative to `.achq/`. */
  image: string;
  policies?: Policy[];
  /** Written at startup. A string is a path relative to `.achq/`; anything else is written as JSON. */
  files?: Record<string, string | Data>;
};

export class Container extends Resource {
  readonly kind = "container";
  constructor(
    name: string,
    readonly inputs: ContainerInputs,
  ) {
    super(name);
  }
}

export type WorkspaceInputs = {
  container: Container;
  threads: ThreadSelector;
  /** Branch template, e.g. `issue-{number}`. */
  branch: string;
  /** The branch a new thread's worktree starts from. */
  base: string;
};

export class Workspace extends Resource {
  readonly kind = "workspace";
  constructor(
    name: string,
    readonly inputs: WorkspaceInputs,
  ) {
    super(name);
  }
}

/** Who does the work. Subclasses (Claude) hold config, which can include code. */
export abstract class Agent<Config = unknown> extends Resource {
  readonly kind = "agent";
  abstract readonly agentKind: string;
  constructor(
    name: string,
    readonly config: Config,
  ) {
    super(name);
  }
}

export class Trigger extends Resource {
  readonly kind = "trigger";
  constructor(
    name: string,
    readonly inputs: { event: EventSelector; agent: Agent },
  ) {
    super(name);
  }
}

/** Turns the registered resources into a plan, checking names and references. */
export const collectPlan = (resources: Resource[] = registry): RepoPlan => {
  const seen = new Set<string>();
  for (const r of resources) {
    const id = `${r.kind}:${r.name}`;
    if (seen.has(id)) throw new Error(`Two ${r.kind}s are named "${r.name}"`);
    seen.add(id);
  }
  const of = <T extends Resource>(type: abstract new (...args: any[]) => T) => resources.filter((r): r is T => r instanceof type);
  const declared = (r: Resource, what: string) => {
    if (!resources.includes(r)) throw new Error(`${what} refers to ${r.kind} "${r.name}", which isn't declared in this config`);
    return r.name;
  };

  const plan: RepoPlan = {
    policies: of(Policy).map((p) => ({ name: p.name, policy: p.policy })),
    containers: of(Container).map((c) => ({
      name: c.name,
      image: c.inputs.image,
      policies: (c.inputs.policies ?? []).map((p) => declared(p, `container ${c.name}`)),
      files: toData(c.inputs.files ?? {}, `container ${c.name} files`) as Record<string, Data>,
    })),
    workspaces: of(Workspace).map((w) => ({
      name: w.name,
      container: declared(w.inputs.container, `workspace ${w.name}`),
      threads: w.inputs.threads.data,
      branch: w.inputs.branch,
      base: w.inputs.base,
    })),
    agents: of(Agent).map((a) => ({ name: a.name, kind: a.agentKind })),
    triggers: of(Trigger).map((t) => ({
      name: t.name,
      event: t.inputs.event.data,
      agent: declared(t.inputs.agent, `trigger ${t.name}`),
    })),
  };
  if (!plan.containers.length) throw new Error("The config declares no containers");
  return plan;
};
