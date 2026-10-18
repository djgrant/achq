import { Agent, collectPlan, registered, resetRegistry, type RepoPlan } from "@achq/core";

let evaluating: Promise<unknown> = Promise.resolve();

/** Imports a bundle into a fresh registry. One at a time, since the registry is shared. */
export const evaluateBundle = (bundle: string): Promise<{ plan: RepoPlan; agents: Agent[] }> => {
  const run = evaluating.then(async () => {
    resetRegistry();
    try {
      await import(bundle);
      const resources = registered();
      return { plan: collectPlan(resources), agents: resources.filter((r): r is Agent => r instanceof Agent) };
    } finally {
      resetRegistry();
    }
  });
  evaluating = run.catch(() => {});
  return run;
};
