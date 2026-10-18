// Runs a bundled config in QuickJS compiled to WebAssembly.
//
// The guest gets QuickJS's language intrinsics and nothing else: no host
// functions are exposed, so it has no filesystem, network, environment, timers
// or `process`. A `console` is defined in guest JavaScript (not a host
// function) so configs that log don't crash; its lines are read back as data.
import { getQuickJS, type QuickJSContext } from "quickjs-emscripten";

export type RunLimits = {
  /** Heap limit for the guest runtime, in bytes. */
  memoryBytes: number;
  /** Wall-clock limit, enforced by QuickJS's interrupt handler. */
  timeoutMs: number;
  stackBytes: number;
  /** Largest plan JSON accepted back from the guest. */
  maxResultBytes: number;
};

export const DEFAULT_LIMITS: RunLimits = { memoryBytes: 64 * 1024 * 1024, timeoutMs: 2_000, stackBytes: 1024 * 1024, maxResultBytes: 1024 * 1024 };

export class SandboxError extends Error {}

const PRELUDE = `(() => {
  const lines = [];
  const log = (...args) => { if (lines.length < 100) lines.push(args.map((a) => { try { return typeof a === "string" ? a : JSON.stringify(a); } catch { return String(a); } }).join(" ").slice(0, 1000)); };
  globalThis.console = { log, info: log, warn: log, error: log, debug: log };
  Object.defineProperty(globalThis, "__achqLogs", { value: lines });
})();`;

/** Runs `script` and returns the string it left in `globalThis.__achqPlan`, plus anything it logged. */
export const runBundle = async (script: string, limits: Partial<RunLimits> = {}): Promise<{ result: string; logs: string[] }> => {
  const { memoryBytes, timeoutMs, stackBytes, maxResultBytes } = { ...DEFAULT_LIMITS, ...limits };
  const quickjs = await getQuickJS();
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(memoryBytes);
  runtime.setMaxStackSize(stackBytes);
  const deadline = Date.now() + timeoutMs;
  let interrupted = false;
  runtime.setInterruptHandler(() => (interrupted ||= Date.now() > deadline));
  const context = runtime.newContext();
  try {
    evaluate(context, PRELUDE, "prelude.js", () => interrupted, timeoutMs);
    let logs: string[] = [];
    try {
      evaluate(context, script, "config.js", () => interrupted, timeoutMs);
    } finally {
      logs = readLogs(context);
    }
    const handle = context.getProp(context.global, "__achqPlan");
    try {
      if (context.typeof(handle) !== "string") throw new SandboxError("The config didn't produce a plan");
      const result = context.getString(handle);
      if (result.length > maxResultBytes) throw new SandboxError(`The config's plan is larger than ${maxResultBytes} bytes`);
      return { result, logs };
    } finally {
      handle.dispose();
    }
  } finally {
    context.dispose();
    runtime.dispose();
  }
};

const evaluate = (context: QuickJSContext, code: string, filename: string, interrupted: () => boolean, timeoutMs: number) => {
  const result = context.evalCode(code, filename, { type: "global", strict: true });
  if (result.error) {
    const error = describe(context.dump(result.error));
    result.error.dispose();
    if (interrupted()) throw new SandboxError(`The config ran for longer than ${timeoutMs}ms and was stopped`);
    if (/out of memory/i.test(error)) throw new SandboxError("The config ran out of memory and was stopped");
    if (/stack overflow/i.test(error)) throw new SandboxError("The config overflowed its stack and was stopped");
    throw new SandboxError(`The config threw: ${error}`);
  }
  result.value.dispose();
};

const readLogs = (context: QuickJSContext): string[] => {
  try {
    const handle = context.getProp(context.global, "__achqLogs");
    const value = context.dump(handle);
    handle.dispose();
    return Array.isArray(value) ? value.filter((l): l is string => typeof l === "string") : [];
  } catch {
    return [];
  }
};

/** A guest error as one line. The guest controls these values, so they're only ever treated as text. */
const describe = (value: unknown): string => {
  if (value && typeof value === "object") {
    const { name, message } = value as { name?: unknown; message?: unknown };
    if (typeof message === "string") return `${typeof name === "string" ? name : "Error"}: ${message}`.slice(0, 2000);
  }
  try {
    return String(JSON.stringify(value) ?? value).slice(0, 2000);
  } catch {
    return "an unprintable value";
  }
};
