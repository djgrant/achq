import { type Json, json } from "@achq/utils/json";
import type { ManifestInput } from "../model/manifest.ts";
import { undeclaredRef } from "../model/resource-data.ts";
import { isAgent, isContainer, isPolicy, isTrigger, isWorkspace } from "../resources/config.ts";
import { declared, type Resource } from "../resources/resource.ts";

/**
 * Turns the declared resources into a manifest. It only checks what needs the
 * resources themselves: that each one referred to is declared in this config,
 * not just named like one. validateManifest (`@achq/core/manifest`) checks the
 * rest, on what this returns.
 */
export const collectManifest = (resources: Resource[] = declared()) => {
  const ofKind = <T extends Resource>(is: (r: Resource) => r is T) => resources.filter(is);
  /** `r`'s name, for `from` to refer to it by. It has to be declared in this config. */
  const refName = (r: Resource, from: string) => {
    if (!resources.includes(r)) throw undeclaredRef(from, r.kind, r.name);
    return r.name;
  };

  return {
    policies: ofKind(isPolicy).map((p) => ({ name: p.name, policy: p.policy })),
    containers: ofKind(isContainer).map((c) => ({
      name: c.name,
      image: c.inputs.image,
      policies: (c.inputs.policies ?? []).map((p) => refName(p, `container ${c.name}`)),
      files: json.from(c.inputs.files ?? {}, `container ${c.name} files`) as Record<string, Json>,
    })),
    workspaces: ofKind(isWorkspace).map((w) => ({
      name: w.name,
      container: refName(w.inputs.container, `workspace ${w.name}`),
      threads: w.inputs.threads.data,
      branch: w.inputs.branch,
      base: w.inputs.base,
    })),
    agents: ofKind(isAgent).map((a) => ({ name: a.name, runtime: a.runtime })),
    triggers: ofKind(isTrigger).map((t) => ({
      name: t.name,
      event: t.inputs.event.data,
      agent: refName(t.inputs.agent, `trigger ${t.name}`),
    })),
  } satisfies ManifestInput;
};
