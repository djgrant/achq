import { Agent, collectPlan, declared, resetDeclarations, type RepoPlan } from "@achq/core";

let evaluating: Promise<unknown> = Promise.resolve();

/** Imports a bundle from no declarations. One at a time, since declarations are shared. */
export const evaluateBundle = (bundle: string): Promise<{ plan: RepoPlan; agents: Agent[] }> => {
  const run = evaluating.then(async () => {
    resetDeclarations();
    try {
      await import(bundle);
      const resources = declared();
      return { plan: collectPlan(resources), agents: resources.filter((r): r is Agent => r instanceof Agent) };
    } finally {
      resetDeclarations();
    }
  });
  evaluating = run.catch(() => {});
  return run;
};
