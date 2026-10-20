// Running other programs: to read their output, to stream it, or to hand them
// the terminal, and stopping them when whoever started them goes away.
import type { Subprocess } from "bun";
import { every } from "./async.ts";

type Env = Record<string, string | undefined>;
export type RunOptions = { cwd?: string; env?: Env };
export type RunResult = { ok: boolean; exitCode: number; stdout: string; stderr: string };

/** Runs `argv` to completion and returns its output. Never throws for a failing command, only for a missing one. */
export const run = (argv: string[], { cwd, env }: RunOptions = {}): RunResult => {
  const proc = Bun.spawnSync(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
  return { ok: proc.success, exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
};

/** `argv`'s trimmed output, or undefined if it fails. */
export const tryRun = (argv: string[], options: RunOptions = {}): string | undefined => {
  const result = run(argv, options);
  return result.ok ? result.stdout.trim() : undefined;
};

/** Calls `fn` with each non-blank line of `stream`, as it arrives. */
export const eachLine = async (stream: ReadableStream<Uint8Array>, fn: (line: string) => void) => {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) if (line.trim()) fn(line);
  }
  if (buffer.trim()) fn(buffer);
};

export type SpawnOptions = RunOptions & {
  /** Written to stdin, which is then closed. Without it, stdin is closed from the start. */
  input?: string;
  /** Gets stdout line by line instead of it being collected. */
  onLine?: (line: string) => void;
  /** Kills the process when aborted. */
  signal?: AbortSignal;
};

/** `signalCode` names the signal that killed it, if one did. */
export type Collected = RunResult & { signalCode: Subprocess["signalCode"] };

/** Runs `argv`, collecting stdout (unless `onLine` takes it) and stderr. Never throws for a failing command. */
export const spawnCollect = async (argv: string[], { cwd, env, input, onLine, signal }: SpawnOptions = {}): Promise<Collected> => {
  const proc = Bun.spawn(argv, { cwd, env, stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  const kill = () => proc.kill();
  if (signal?.aborted) kill();
  signal?.addEventListener("abort", kill);
  if (input !== undefined && proc.stdin) {
    proc.stdin.write(input);
    proc.stdin.end();
  }
  try {
    const stdout = onLine ? eachLine(proc.stdout, onLine).then(() => "") : new Response(proc.stdout).text();
    const [out, stderr, exitCode] = await Promise.all([stdout, new Response(proc.stderr).text(), proc.exited]);
    return { ok: exitCode === 0, exitCode, stdout: out, stderr, signalCode: proc.signalCode };
  } finally {
    signal?.removeEventListener("abort", kill);
  }
};

type Killable = { kill(signal?: NodeJS.Signals): void };

/** Passes each of `signals` this process gets on to `proc`, until the returned function is called. */
export const forwardSignals = (proc: Killable, signals: readonly NodeJS.Signals[]): (() => void) => {
  const handlers = signals.map((signal) => [signal, () => proc.kill(signal)] as const);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
};

/**
 * Sends `signal` to `proc` once this process's parent has gone (a dropped SSH
 * session doesn't always reach the child). Checks every `intervalMs` until the
 * returned function is called.
 */
export const killWhenOrphaned = (proc: Killable, { intervalMs, signal }: { intervalMs: number; signal: NodeJS.Signals }): (() => void) => {
  const parent = process.ppid;
  return every(intervalMs, () => {
    if (process.ppid !== parent) proc.kill(signal);
  });
};

/** Opens `url` in the default browser, ignoring the opener's output. */
export const openUrl = (url: string) => {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  Bun.spawnSync([opener, url], { stdout: "ignore", stderr: "ignore" });
};

/** Throws `Needs <what>: <install>` unless `name` is on the PATH. */
export const requireBinary = (name: string, what: string, install: string) => {
  if (!Bun.which(name)) throw new Error(`Needs ${what}: ${install}`);
};
