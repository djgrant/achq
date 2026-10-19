import { Agent, collectManifest, declared, resetDeclarations, type RepoManifest } from "@achq/core";

let evaluating: Promise<unknown> = Promise.resolve();

/** Imports a bundle from no declarations. One at a time, since declarations are shared. */
export const evaluateBundle = (bundle: string): Promise<{ manifest: RepoManifest; agents: Agent[] }> => {
  const run = evaluating.then(async () => {
    resetDeclarations();
    try {
      await import(bundle);
      const resources = declared();
      return { manifest: collectManifest(resources), agents: resources.filter((r): r is Agent => r instanceof Agent) };
    } finally {
      resetDeclarations();
    }
  });
  evaluating = run.catch(() => {});
  return run;
};
