import { PLUGIN } from "../plugin.ts";
import type { Plugin, Resource } from "../resources/resource.ts";

/** Roles whose plugin a container loads: channels, policies and agent runtimes. */
const CONTAINER_ROLES = new Set(["channel", "policy", "agent-runtime"]);
/** Roles only containers load: the router and deployer never run an agent. */
const CONTAINER_ONLY_ROLES = new Set(["agent-runtime"]);

const roleOf = (r: Resource) => r.role ?? r.kind;

/** The plugins each kind of process loads: `services` the router and deployer, `containers` every repo container. */
export type PluginLists = { services: Plugin[]; containers: Plugin[] };

/** Each package once, without core, which every process already has. One package at two versions can't be installed side by side. */
const unique = (plugins: Plugin[]) => {
  const byPackage = new Map<string, Plugin>();
  for (const plugin of plugins) {
    if (plugin.package === PLUGIN.package) continue;
    const seen = byPackage.get(plugin.package);
    if (seen && seen.version !== plugin.version) throw new Error(`${plugin.package} is declared at both ${seen.version} and ${plugin.version}: install one version of it`);
    byPackage.set(plugin.package, plugin);
  }
  return [...byPackage.values()];
};

/** The plugins the declared resources come from, by the processes that load them. */
export const pluginsOf = (resources: Resource[]): PluginLists => ({
  services: unique(resources.filter((r) => !CONTAINER_ONLY_ROLES.has(roleOf(r))).map((r) => r.plugin)),
  containers: unique(resources.filter((r) => CONTAINER_ROLES.has(roleOf(r))).map((r) => r.plugin)),
});
