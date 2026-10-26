import type { Check } from "@achq/core";
import { Env, type Vars } from "@achq/utils/env";
import { agentContainerEnv, containerProviderNamed } from "@achq/registry";
import { loadInfra } from "../tasks/infra.load.ts";

/** What to make sure of before reaching the infra in `file`: what its container provider checks, e.g. that Railway takes your token. */
export const infraChecks = async (file: string, env: Vars) => {
  const { deployer } = await loadInfra(file);
  return containerProviderNamed(deployer.containerProvider).checks?.(env) ?? [];
};

/**
 * That `env` has what every container gets from it: each agent runtime's variables. A check rather than a pok env,
 * until we've checked how a pok env behaves when a variable it needs is missing.
 */
export const agentContainerEnvCheck = (env: Vars) => ({
  label: "Agent container variables",
  check: async () => {
    for (const { name, hint } of agentContainerEnv()) new Env(env).require(name, hint);
  },
}) satisfies Check;
