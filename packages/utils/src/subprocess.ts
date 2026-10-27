import type { Subprocess } from "bun";
import { async } from "./async.ts";
import type { Vars } from "./env.ts";
import { text } from "./text.ts";

export type RunOptions = { cwd?: string; env?: Vars };
export type RunResult = { ok: boolean; exitCode: number; stdout: string; stderr: string };

export type CollectOptions = RunOptions & {
  /** Written to stdin, which is then closed. Without it, stdin is closed from the start. */
  input?: string;
  /** Gets stdout line by line instead of it being collected. */
  onLine?: (line: string) => void;
  signal?: AbortSignal;
};

export type Collected = RunResult & { signalCode: Subprocess["signalCode"] };

/** What a command printed. */
export type Printed = Pick<RunResult, "stdout" | "stderr">;

type Killable = { kill(signal?: NodeJS.Signals): void };

export const subprocess = {
  /** Never throws for a failing command, only for a missing one. */
  run: (argv: string[], { cwd, env }: RunOptions = {}) => {
    const proc = Bun.spawnSync(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
    return { ok: proc.success, exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
  },

  /** Its output, trimmed, or undefined if it fails. */
  tryRun: (argv: string[], options: RunOptions = {}) => {
    const result = subprocess.run(argv, options);
    return result.ok ? result.stdout.trim() : undefined;
  },

  /** Calls `fn` with each non-blank line of `stream`, as it arrives. */
  eachLine: async (stream: ReadableStream<Uint8Array>, fn: (line: string) => void) => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) if (line.trim()) fn(line);
    }
    if (buffer.trim()) fn(buffer);
  },

  /** Runs `argv` to the end, collecting its output. Never throws for a failing command. */
  collect: async (argv: string[], { cwd, env, input, onLine, signal }: CollectOptions = {}) => {
    const proc = Bun.spawn(argv, { cwd, env, stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
    const kill = () => proc.kill();
    if (signal?.aborted) kill();
    signal?.addEventListener("abort", kill);
    if (input !== undefined && proc.stdin) {
      proc.stdin.write(input);
      proc.stdin.end();
    }
    try {
      const stdout = onLine ? subprocess.eachLine(proc.stdout, onLine).then(() => "") : new Response(proc.stdout).text();
      const [out, stderr, exitCode] = await Promise.all([stdout, new Response(proc.stderr).text(), proc.exited]);
      return { ok: exitCode === 0, exitCode, stdout: out, stderr, signalCode: proc.signalCode };
    } finally {
      signal?.removeEventListener("abort", kill);
    }
  },

  /** What a failed command said: its stderr, or its stdout if it said nothing there. Trimmed. */
  said: ({ stdout, stderr }: Printed) => stderr.trim() || stdout.trim(),

  /** The last `lines` non-blank lines of what it printed, stdout then stderr: for a command whose long log ends with why it failed. */
  tail: ({ stdout, stderr }: Printed, lines: number) => text.tailLines(`${stdout}\n${stderr}`, lines).join("\n"),

  /** Runs `argv` to the end and gives its stdout. If it fails, throws `failure` and what it said. */
  output: async (argv: string[], options: CollectOptions, failure: string) => {
    const result = await subprocess.collect(argv, options);
    if (!result.ok) throw new Error(`${failure}: ${subprocess.said(result)}`);
    return result.stdout;
  },

  forwardSignals: (proc: Killable, signals: readonly NodeJS.Signals[]): (() => void) => {
    const handlers = signals.map((signal) => [signal, () => proc.kill(signal)] as const);
    for (const [signal, handler] of handlers) process.on(signal, handler);
    return () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
  },

  /**
   * Sends `signal` to `proc` once this process's parent has gone (a dropped SSH
   * session doesn't always reach the child). Checks every `intervalMs` until the
   * returned function is called.
   */
  killWhenOrphaned: (proc: Killable, { intervalMs, signal }: { intervalMs: number; signal: NodeJS.Signals }): (() => void) => {
    const parent = process.ppid;
    return async.every(intervalMs, () => {
      if (process.ppid !== parent) proc.kill(signal);
    });
  },

  /** Opens `url` in your browser. */
  /** Whether the browser opened it. */
  openUrl: (url: string) => {
    const cmd =
      process.platform === "darwin"
        ? ["open", url]
        : process.platform === "win32"
          ? ["cmd", "/c", "start", "", url.replaceAll("&", "^&")]
          : ["xdg-open", url];
    return Bun.spawnSync(cmd, { stdout: "ignore", stderr: "ignore" }).success;
  },

  requireBinary: (name: string, what: string, install: string) => {
    if (!Bun.which(name)) throw new Error(`Needs ${what}: ${install}`);
  },
};
