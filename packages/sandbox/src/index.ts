// Runs ES modules in QuickJS compiled to WebAssembly. The guest gets the
// language's intrinsics and the modules it's given: no host functions, so no
// filesystem, network, environment, timers or `process`. `console` is guest
// JavaScript, so code that logs doesn't crash; its lines come back as data.
import { getQuickJS, type QuickJSContext, type QuickJSHandle } from "quickjs-emscripten";

export type Limits = {
  memoryBytes: number;
  /** Wall-clock limit, enforced by QuickJS's interrupt handler. */
  timeoutMs: number;
  stackBytes: number;
  /** Largest result accepted back from the guest. */
  maxResultBytes: number;
};

export const DEFAULT_LIMITS: Limits = { memoryBytes: 64 * 1024 * 1024, timeoutMs: 2_000, stackBytes: 1024 * 1024, maxResultBytes: 1024 * 1024 };

/** The name `specifier` refers to when imported from `importer`, or undefined if there's no such module. */
export type Resolve = (specifier: string, importer: string) => string | undefined;

export type RunOptions = {
  /** Module sources by name. Only these exist. */
  modules: Record<string, string>;
  /** Defaults to exact names, and relative paths between them. */
  resolve?: Resolve;
  limits?: Partial<Limits>;
};

/** Its message completes "The code …", e.g. "threw: Error: nope". */
export class SandboxError extends Error {}

/** QuickJS drops a resolver's error, so a missing import goes to the loader under this name instead. */
const MISSING = "missing:";

const PRELUDE = `(() => {
  const lines = [];
  const log = (...args) => { if (lines.length < 100) lines.push(args.map((a) => { try { return typeof a === "string" ? a : JSON.stringify(a); } catch { return String(a); } }).join(" ").slice(0, 1000)); };
  globalThis.console = { log, info: log, warn: log, error: log, debug: log };
  Object.defineProperty(globalThis, "__logs", { value: lines });
})();`;

export const relative: Resolve = (specifier, importer) => {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return specifier;
  const parts = importer.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  return parts.join("/");
};

/** Evaluates `entry` and returns its default export, which must be a string, and anything it logged. */
export const run = async (entry: string, options: RunOptions): Promise<{ result: string; logs: string[] }> => {
  const { modules, resolve = relative } = options;
  const { memoryBytes, timeoutMs, stackBytes, maxResultBytes } = { ...DEFAULT_LIMITS, ...options.limits };
  if (!(entry in modules)) throw new SandboxError(`has no module ${entry}`);
  const quickjs = await getQuickJS();
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(memoryBytes);
  runtime.setMaxStackSize(stackBytes);
  const deadline = Date.now() + timeoutMs;
  let interrupted = false;
  runtime.setInterruptHandler(() => (interrupted ||= Date.now() > deadline));
  runtime.setModuleLoader(
    (name) => {
      if (name in modules) return modules[name]!;
      const [importer, specifier] = name.startsWith(MISSING) ? JSON.parse(name.slice(MISSING.length)) : ["", name];
      return { error: new Error(`${importer} imports "${specifier}", which doesn't exist`) };
    },
    (importer, specifier) => {
      const name = resolve(specifier, importer);
      return name !== undefined && name in modules ? name : MISSING + JSON.stringify([importer, specifier]);
    },
  );
  const context = runtime.newContext();
  const fail = (handle: QuickJSHandle) => {
    const error = describe(context.dump(handle));
    handle.dispose();
    if (interrupted) return new SandboxError(`ran for longer than ${timeoutMs}ms and was stopped`);
    if (/out of memory/i.test(error)) return new SandboxError("ran out of memory and was stopped");
    if (/stack overflow/i.test(error)) return new SandboxError("overflowed its stack and was stopped");
    return new SandboxError(`threw: ${error}`);
  };
  try {
    context.unwrapResult(context.evalCode(PRELUDE, "prelude.js", { type: "global", strict: true })).dispose();
    const evaluated = context.evalCode(modules[entry]!, entry, { type: "module", strict: true });
    if (evaluated.error) throw fail(evaluated.error);
    const exports = settle(context, evaluated.value, fail);
    const value = context.getProp(exports, "default");
    exports.dispose();
    try {
      const type = context.typeof(value);
      if (type !== "string") throw new SandboxError(`returned ${type === "undefined" ? "nothing" : type === "object" ? "an object" : `a ${type}`}, not a string`);
      const result = context.getString(value);
      if (result.length > maxResultBytes) throw new SandboxError(`returned more than ${maxResultBytes} bytes`);
      return { result, logs: readLogs(context) };
    } finally {
      value.dispose();
    }
  } finally {
    context.dispose();
    runtime.dispose();
  }
};

/** A module with top-level await evaluates to a promise for its exports; anything else is its exports. */
const settle = (context: QuickJSContext, handle: QuickJSHandle, fail: (h: QuickJSHandle) => SandboxError): QuickJSHandle => {
  const pending = context.runtime.executePendingJobs();
  if (pending.error) throw fail(pending.error);
  const state = context.getPromiseState(handle);
  if (state.type === "fulfilled") {
    if (state.notAPromise) return handle;
    handle.dispose();
    return state.value;
  }
  handle.dispose();
  if (state.type === "rejected") throw fail(state.error);
  throw new SandboxError("never finished: it awaits something that never settles");
};

const readLogs = (context: QuickJSContext): string[] => {
  try {
    const handle = context.getProp(context.global, "__logs");
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
