import type { Expander, Resource } from "@achq/core";
import type { Graph } from "@achq/reconcile";

/**
 * Adds each resource to the graph with the first expander for its class.
 * Returns how to get a resource's handle; a resource that another uses is
 * expanded first.
 */
export const expandInfra = (resources: Resource[], expanders: Expander[], graph: Graph) => {
  const handles = new Map<Resource, unknown>();
  const expanding = new Set<Resource>();
  const handle = <H>(resource: Resource): H => {
    if (handles.has(resource)) return handles.get(resource) as H;
    if (expanding.has(resource)) throw new Error(`${resource.kind} ${resource.name} depends on itself`);
    const expander = expanders.find((e) => resource instanceof e.resource);
    if (!expander) throw new Error(`Nothing here can run ${resource.kind} ${resource.name}: declare it with a platform's class, e.g. railway.Router`);
    expanding.add(resource);
    const h = expander.expand(resource, { graph, handle });
    handles.set(resource, h);
    return h as H;
  };
  for (const r of resources) handle(r);
  return handle;
};
