import { describe, expect, test } from "bun:test";
import { subprocess } from "../src/subprocess.ts";

describe("run", () => {
  test("returns output and status without throwing for a failing command", () => {
    expect(subprocess.run(["sh", "-c", "echo out; echo err >&2; exit 3"])).toEqual({ ok: false, exitCode: 3, stdout: "out\n", stderr: "err\n" });
    expect(subprocess.run(["pwd"], { cwd: "/" }).stdout.trim()).toBe("/");
    expect(subprocess.run(["sh", "-c", "echo $X"], { env: { ...process.env, X: "y" } }).stdout).toBe("y\n");
  });

  test("tryRun gives trimmed output, or undefined on failure", () => {
    expect(subprocess.tryRun(["echo", " hi "])).toBe("hi");
    expect(subprocess.tryRun(["false"])).toBeUndefined();
  });
});

test("eachLine gives non-blank lines, including an unterminated last one", async () => {
  const chunks = ["a\nb", "c\n\n", "d"].map((s) => new TextEncoder().encode(s));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  const lines: string[] = [];
  await subprocess.eachLine(stream, (line) => lines.push(line));
  expect(lines).toEqual(["a", "bc", "d"]);
});

describe("spawnCollect", () => {
  test("feeds input and collects output", async () => {
    const result = await subprocess.collect(["sh", "-c", "cat; echo oops >&2"], { input: "hello" });
    expect(result).toMatchObject({ ok: true, exitCode: 0, stdout: "hello", stderr: "oops\n" });
  });

  test("streams lines to onLine instead of collecting them", async () => {
    const lines: string[] = [];
    const result = await subprocess.collect(["sh", "-c", "echo one; echo two"], { onLine: (l) => lines.push(l) });
    expect(lines).toEqual(["one", "two"]);
    expect(result.stdout).toBe("");
  });

  test("kills the process when the signal aborts", async () => {
    const result = await subprocess.collect(["sleep", "10"], { signal: AbortSignal.timeout(50) });
    expect(result.ok).toBe(false);
    expect(result.signalCode).toBe("SIGTERM");
  });
});

test("forwardSignals passes signals on until disposed", () => {
  const sent: string[] = [];
  const stop = subprocess.forwardSignals({ kill: (s) => void sent.push(s!) }, ["SIGUSR2"]);
  process.emit("SIGUSR2", "SIGUSR2");
  stop();
  process.emit("SIGUSR2", "SIGUSR2");
  expect(sent).toEqual(["SIGUSR2"]);
});

test("requireBinary says how to install what's missing", () => {
  expect(() => subprocess.requireBinary("sh", "a shell", "-")).not.toThrow();
  expect(() => subprocess.requireBinary("no-such-binary-achq", "the Railway CLI", "brew install railway")).toThrow("Needs the Railway CLI: brew install railway");
});
