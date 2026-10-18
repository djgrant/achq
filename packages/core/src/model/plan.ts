import { type Data, toData } from "./data.ts";
import { registered } from "./registry.ts";
import { Agent, Container, Policy, type PolicyData, type Resource, type SelectorData, Trigger, Workspace } from "./resources.ts";

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

/** Turns the registered resources into a plan, checking names and references. */
export const collectPlan = (resources: Resource[] = registered()): RepoPlan => {
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
