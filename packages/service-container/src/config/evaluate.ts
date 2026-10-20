import { Agent, collectManifest, declared, resetDeclarations, type RepoManifest } from "@achq/core";
import { serial } from "@achq/utils/async";

/** Declarations are shared module state, so one evaluation at a time. */
const oneAtATime = serial();

/** Imports a bundle from no declarations. One at a time, since declarations are shared. */
export const evaluateBundle = (bundle: string): Promise<{ manifest: RepoManifest; agents: Agent[] }> =>
  oneAtATime(async () => {
    resetDeclarations();
    try {
      await import(bundle);
      const resources = declared();
      return { manifest: collectManifest(resources), agents: resources.filter((r): r is Agent => r instanceof Agent) };
    } finally {
      resetDeclarations();
    }
  });
