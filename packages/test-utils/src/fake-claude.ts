import * as fs from "node:fs";
import * as path from "node:path";

export type ClaudeCall = { argv: string[]; env: Record<string, string>; stdin: string; cwd: string; start: number; end: number };

/**
 * A `claude` that records its argv, env, stdin and cwd to $FAKE_CLAUDE_LOG,
 * writes the session's transcript like Claude Code does, and emits stream-json.
 * $FAKE_CLAUDE_DELAY_MS makes runs take time; $FAKE_CLAUDE_FAIL makes them fail.
 */
export const fakeClaude = (dir: string) => {
  const bin = path.join(dir, "claude");
  const log = path.join(dir, "calls");
  fs.mkdirSync(log, { recursive: true });
  // A shell wrapper, since bun's path may have spaces a shebang can't hold.
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath.replace(/'/g, `'\\''`)}' '${bin}.js' "$@"\n`);
  fs.writeFileSync(
    `${bin}.js`,
    `const fs = require("node:fs");
const argv = process.argv.slice(2);
const stdin = argv.includes("-p") ? await Bun.stdin.text() : "";
const start = Date.now();
await Bun.sleep(Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 0));
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
if (process.env.FAKE_CLAUDE_FAIL) { console.error("boom: " + process.env.FAKE_CLAUDE_FAIL); process.exit(3); }
out({ type: "result", subtype: "success", is_error: false, session_id: id, num_turns: 1, result: "Reply for " + id, modelUsage: { m: { contextWindow: 200000 } } });
`,
  );
  fs.chmodSync(bin, 0o755);
  const calls = (): ClaudeCall[] =>
    fs
      .readdirSync(log)
      .sort((a, b) => Number(a.split("-")[0]) - Number(b.split("-")[0]))
      .map((f) => JSON.parse(fs.readFileSync(path.join(log, f), "utf8")));
  return { bin, log, calls, flag: (call: ClaudeCall, name: string) => call.argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1) };
};
