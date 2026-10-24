import * as fs from "node:fs";
import * as path from "node:path";
import { fakeBin } from "./fake-bin.ts";

export type ClaudeCall = { argv: string[]; env: Record<string, string>; stdin: string; cwd: string; start: number; end: number };

/**
 * A `claude` that records its argv, env, stdin and cwd to $FAKE_CLAUDE_LOG,
 * writes the session's transcript like Claude Code does, and emits stream-json.
 * $FAKE_CLAUDE_DELAY_MS makes runs take time; $FAKE_CLAUDE_FAIL makes them fail.
 * `control` does the same for every run from then on, and while a run is going
 * its pid is in `running()`.
 */
export const fakeClaude = (dir: string) => {
  const log = path.join(dir, "calls");
  const running = path.join(dir, "running");
  const control = path.join(dir, "control.json");
  fs.mkdirSync(log, { recursive: true });
  fs.mkdirSync(running, { recursive: true });
  const bin = fakeBin(
    dir,
    "claude",
    `const fs = require("node:fs");
const argv = process.argv.slice(2);
const stdin = argv.includes("-p") ? await Bun.stdin.text() : "";
const start = Date.now();
const control = fs.existsSync(${JSON.stringify(control)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(control)}, "utf8")) : {};
const fail = control.fail ?? process.env.FAKE_CLAUDE_FAIL;
const marker = ${JSON.stringify(running)} + "/" + process.pid;
fs.writeFileSync(marker, "");
await Bun.sleep(Number(control.delayMs ?? process.env.FAKE_CLAUDE_DELAY_MS ?? 0));
fs.rmSync(marker, { force: true });
const flag = (name) => argv.find((a) => a.startsWith(name + "="))?.slice(name.length + 1);
const id = flag("--session-id") ?? flag("--resume");
const projects = process.env.CLAUDE_CONFIG_DIR + "/projects/-wt";
fs.mkdirSync(projects, { recursive: true });
fs.appendFileSync(projects + "/" + id + ".jsonl", JSON.stringify({ stdin }) + "\\n");
fs.writeFileSync(process.env.FAKE_CLAUDE_LOG + "/" + start + "-" + Math.random().toString(36).slice(2) + ".json",
  JSON.stringify({ argv, env: process.env, stdin, cwd: process.cwd(), start, end: Date.now() }));
const out = (e) => console.log(JSON.stringify(e));
out({ type: "system", subtype: "init", session_id: id });
if (stdin.startsWith("/compact")) out({ type: "system", subtype: "compact_boundary", session_id: id, compact_metadata: { pre_tokens: 150000, post_tokens: 20000 } });
out({ type: "assistant", session_id: id, message: { content: [{ type: "text", text: "working" }], usage: { input_tokens: 10, output_tokens: 5 } } });
if (fail) { console.error("boom: " + fail); process.exit(3); }
out({ type: "result", subtype: "success", is_error: false, session_id: id, num_turns: 1, result: "Reply for " + id, modelUsage: { m: { contextWindow: 200000 } } });
`,
  );
  const calls = (): ClaudeCall[] =>
    fs
      .readdirSync(log)
      .sort((a, b) => Number(a.split("-")[0]) - Number(b.split("-")[0]))
      .map((f) => JSON.parse(fs.readFileSync(path.join(log, f), "utf8")));
  return {
    bin,
    log,
    calls,
    flag: (call: ClaudeCall, name: string) => call.argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1),
    /** How every run from now behaves: `delayMs` before answering, and `fail` to exit with that error instead. */
    control: (options: { delayMs?: number; fail?: string }) => fs.writeFileSync(control, JSON.stringify(options)),
    /** The pids of runs still going. */
    running: () => fs.readdirSync(running).map(Number),
    /** Kills the runs still going, as a crash would. */
    kill: () => {
      for (const pid of fs.readdirSync(running).map(Number)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
        fs.rmSync(path.join(running, String(pid)), { force: true });
      }
    },
  };
};
