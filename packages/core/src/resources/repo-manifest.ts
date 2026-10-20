import { duplicates } from "@achq/utils/collections";
import { type Data, toData } from "./data.ts";
import { declared } from "./declarations.ts";
import { Agent, Container, Policy, type PolicyData, type SelectorData, Trigger, Workspace } from "./config.ts";
import type { Resource } from "./resource.ts";

/**
 * What a repo's config evaluates to: every resource as plain data. Resources
 * refer to each other by name. Arrays keep declaration order, which decides
 * which workspace claims a thread.
 */
export type RepoManifest = {
  policies: { name: string; policy: PolicyData }[];
  containers: { name: string; image: string; policies: string[]; files: Record<string, Data> }[];
  workspaces: { name: string; container: string; threads: SelectorData; branch: string; base: string }[];
  agents: { name: string; runtime: string }[];
  triggers: { name: string; event: SelectorData; agent: string }[];
};

type ResourceClass<T extends Resource> = abstract new (...args: any[]) => T;

/** A resource's identity within a config: names are unique per kind. */
const resourceId = (r: Resource) => `${r.kind}:${r.name}`;

const assertUniqueNames = (resources: Resource[]) => {
  const [repeated] = duplicates(resources.map(resourceId));
  if (!repeated) return;
  const r = resources.find((x) => resourceId(x) === repeated)!;
  throw new Error(`Two ${r.kind}s are named "${r.name}"`);
};

/** Turns the declared resources into a manifest, checking names and references. */
export const collectManifest = (resources: Resource[] = declared()): RepoManifest => {
  assertUniqueNames(resources);
  const ofKind = <T extends Resource>(type: ResourceClass<T>) => resources.filter((r): r is T => r instanceof type);
  /** `r`'s name, for `from` to refer to it by. It has to be declared in this config. */
  const refName = (r: Resource, from: string) => {
    if (!resources.includes(r)) throw new Error(`${from} refers to ${r.kind} "${r.name}", which isn't declared in this config`);
    return r.name;
  };

  const manifest: RepoManifest = {
    policies: ofKind(Policy).map((p) => ({ name: p.name, policy: p.policy })),
    containers: ofKind(Container).map((c) => ({
      name: c.name,
      image: c.inputs.image,
      policies: (c.inputs.policies ?? []).map((p) => refName(p, `container ${c.name}`)),
      files: toData(c.inputs.files ?? {}, `container ${c.name} files`) as Record<string, Data>,
    })),
    workspaces: ofKind(Workspace).map((w) => ({
      name: w.name,
      container: refName(w.inputs.container, `workspace ${w.name}`),
      threads: w.inputs.threads.data,
      branch: w.inputs.branch,
      base: w.inputs.base,
    })),
    agents: ofKind(Agent).map((a) => ({ name: a.name, runtime: a.runtime })),
    triggers: ofKind(Trigger).map((t) => ({
      name: t.name,
      event: t.inputs.event.data,
      agent: refName(t.inputs.agent, `trigger ${t.name}`),
    })),
  };
  if (!manifest.containers.length) throw new Error("The config declares no containers");
  return manifest;
};
