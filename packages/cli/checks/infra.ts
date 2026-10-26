import type { Check } from "@achq/core";
import { Env, type Vars } from "@achq/utils/env";
import { loadInfra } from "../tasks/infra.load.ts";

/** What every container gets from your environment: each of the infra's agent runtimes' variables. */
export const runtimesEnv = (runtimes: { containerEnv: { name: string; hint?: string }[] }[]) => runtimes.flatMap((r) => r.containerEnv);

/**
 * What to make sure of before reaching the infra in `file`: what its container
 * provider checks, e.g. that Railway takes your token, and that `env` has what
 * every container gets from it. The latter is a check rather than a pok env,
 * until we've checked how a pok env behaves when a variable it needs is missing.
 */
export const infraChecks = async (file: string, env: Vars): Promise<Check[]> => {
  const { deployer, runtimes } = await loadInfra(file);
  return [
    ...(deployer.provider.checks?.(env) ?? []),
    {
      label: "Agent container variables",
      check: async () => {
        for (const { name, hint } of runtimesEnv(runtimes)) new Env(env).require(name, hint);
      },
    },
  ];
};
