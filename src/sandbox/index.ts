// Evaluates a repo's `.achq/config.ts` without trusting it: bundled with
// macros off (bundle.ts), run in QuickJS/WebAssembly with memory and time
// limits (run.ts), and its plan checked strictly on the way out (plan-schema.ts).
// Every error is an `Error` whose message is fit for ACHQ_STATUS.
import type { RepoPlan } from "../core/resources.ts";
import { bundleConfig, ConfigError } from "./bundle.ts";
import { parsePlan } from "./plan-schema.ts";
import { runBundle, type RunLimits, SandboxError } from "./run.ts";

export { ConfigError, isSourceFile, normaliseRepoPath } from "./bundle.ts";
export { DEFAULT_LIMITS, type RunLimits, SandboxError } from "./run.ts";
export { parsePlan } from "./plan-schema.ts";

export type Evaluate = (files: Record<string, string>) => Promise<RepoPlan>;

/** `files` are the repo's `.achq/` files, keyed by path relative to `.achq/` (`config.ts`, `lib/x.ts`). */
export const evaluateConfig = async (files: Record<string, string>, limits: Partial<RunLimits> = {}): Promise<RepoPlan> => {
  const script = await bundleConfig(files);
  const { result, logs } = await runBundle(script, limits).catch((error) => {
    throw error instanceof SandboxError ? error : new SandboxError(`The config sandbox failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  try {
    return parsePlan(result);
  } catch (error) {
    const tail = logs.length ? ` (config logged: ${logs.slice(-3).join(" | ")})` : "";
    throw new ConfigError(`${(error as Error).message}${tail}`);
  }
};
