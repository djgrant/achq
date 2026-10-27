import { CORE_PLUGIN, type Plugin } from "@achq/core";
import { defineTask } from "@pokit/core";
import * as v from "valibot";
import { type Npm, npm } from "../io/npm.ts";
import { given, givenOr } from "./params.ts";

/** What achq runs besides the plugins: the services and the containers' runner, at the version core is. */
const SERVICES = ["@achq/router", "@achq/deployer", "@achq/runner"];

/**
 * That every package the services and containers will install is on npm, and
 * that each plugin works with the version of core they run: before anything
 * is applied, as a service that can't install them doesn't start.
 */
export const infraCheckPlugins = defineTask({
  label: "Check the plugins on npm",
  params: v.object({ plugins: given<Plugin[]>(), core: v.string(), npm: givenOr<Npm>(() => npm) }),
  run: async (_r, { params: { plugins, core, npm } }) => {
    // A plugin both the services and containers load is looked up once.
    const wanted = [...SERVICES.map((name) => ({ package: name, version: core })), ...plugins].filter(
      (p, i, all) => all.findIndex((q) => q.package === p.package && q.version === p.version) === i,
    );
    const problems = await Promise.all(
      wanted.map(async ({ package: name, version }) => {
        const published = await npm(name, version);
        if (!published) return `${name}@${version} isn't on npm`;
        const range = published.peerDependencies?.[CORE_PLUGIN.package];
        if (range && !Bun.semver.satisfies(core, range)) return `${name}@${version} needs ${CORE_PLUGIN.package}@${range}, but the services run ${core}`;
      }),
    );
    const found = problems.filter((p) => p !== undefined);
    if (found.length) throw new Error(`The infra's plugins can't be installed:\n${found.map((p) => `  ${p}`).join("\n")}`);
  },
});
