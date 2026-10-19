import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resetDeclarations, type RunContext, type RuntimeContext } from "@achq/core";
import { fakeClaude } from "@achq/test-utils/fake-claude";
import { tempDir } from "@achq/test-utils/temp-dir";
import { claudeAgentProvider } from "../src/agent/index.ts";
import { DENIED } from "../src/lib/constants.ts";
import { Agent, type AgentConfig } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => {
  resetDeclarations();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const setup = () => {
  const root = tempDir(dirs);
  const achq = path.join(root, ".achq");
  fs.mkdirSync(path.join(achq, "prompts"), { recursive: true });
  fs.writeFileSync(path.join(achq, "prompts/system.md"), "Repo prompt.\n");
  fs.writeFileSync(path.join(achq, "statusline.sh"), "echo hi\n");
  const claude = fakeClaude(root);
  const read = (relative: string) => fs.readFileSync(path.join(achq, relative), "utf8");
  const ctx: RuntimeContext = {
    readFile: read,
    resolveFiles: (files) => Object.fromEntries(Object.entries(files ?? {}).map(([k, v]) => [k, typeof v === "string" ? read(v) : `${JSON.stringify(v, null, 2)}\n`])),
    home: path.join(root, "home"),
    runnerPrompt: "Runner prompt.\n",
    containerFiles: { "~/.config/tool.toml": "level = 1\n" },
    env: { ACHQ_CLAUDE_BIN: claude.bin },
  };
  const runtime = (config: AgentConfig, c: RuntimeContext = ctx, name = "coder") => claudeAgentProvider.runtime(new Agent(name, config), c);
  return { root, achq, ctx, runtime, claude };
};

describe("session keys", () => {
  test("change with everything in the cached prefix, and nothing else", async () => {
    const { achq, ctx, runtime } = setup();
    const base: AgentConfig = { model: "claude-opus-5-5", effort: "high", systemPrompt: "./prompts/system.md", settings: { a: 1 }, files: { "~/.claude/statusline.sh": "./statusline.sh" } };
    const key = await runtime(base).sessionKey();
    expect(await runtime({ ...base }).sessionKey()).toBe(key);
    // Key order in settings doesn't matter.
    expect(await runtime({ ...base, settings: { a: 1 } }).sessionKey()).toBe(key);

    const different = [
      await runtime(base, ctx, "other").sessionKey(),
      await runtime({ ...base, model: "claude-haiku-5-5" }).sessionKey(),
      await runtime({ ...base, effort: "max" }).sessionKey(),
      await runtime({ ...base, settings: { a: 2 } }).sessionKey(),
      await runtime(base, { ...ctx, runnerPrompt: "A new runner prompt.\n" }).sessionKey(),
      await runtime(base, { ...ctx, containerFiles: { "~/.config/tool.toml": "level = 2\n" } }).sessionKey(),
    ];
    fs.writeFileSync(path.join(achq, "prompts/system.md"), "Changed repo prompt.\n");
    different.push(await runtime(base).sessionKey());
    fs.writeFileSync(path.join(achq, "prompts/system.md"), "Repo prompt.\n");
    fs.writeFileSync(path.join(achq, "statusline.sh"), "echo changed\n");
    different.push(await runtime(base).sessionKey());
    expect(new Set([key, ...different]).size).toBe(different.length + 1);

    // The binary isn't part of it (Claude Code's version isn't keyed).
    fs.writeFileSync(path.join(achq, "statusline.sh"), "echo hi\n");
    expect(await runtime(base, { ...ctx, env: { ACHQ_CLAUDE_BIN: "/elsewhere/claude" } }).sessionKey()).toBe(key);
  });
});

describe("configure", () => {
  test("writes settings (defaults, then the repo's), the combined system prompt and agent files", async () => {
    const { root, ctx, runtime } = setup();
    const configDir = path.join(root, "agents/coder");
    const r = runtime({ effort: "xhigh", systemPrompt: "./prompts/system.md", settings: { model: "claude-sonnet-5", attribution: { commit: "x" } }, files: { "~/.claude/statusline.sh": "./statusline.sh", "~/.npmrc": { a: 1 } } });
    await r.configure(configDir);
    expect(JSON.parse(fs.readFileSync(path.join(configDir, "settings.json"), "utf8"))).toEqual({ model: "claude-sonnet-5", effortLevel: "xhigh", attribution: { commit: "x" } });
    expect(fs.readFileSync(path.join(configDir, "achq-system-prompt.md"), "utf8")).toBe("Runner prompt.\n\nRepo prompt.\n");
    expect(fs.readFileSync(path.join(configDir, "statusline.sh"), "utf8")).toBe("echo hi\n");
    expect(JSON.parse(fs.readFileSync(path.join(ctx.home, ".npmrc"), "utf8"))).toEqual({ a: 1 });
    expect(JSON.parse(fs.readFileSync(path.join(configDir, ".claude.json"), "utf8")).hasCompletedOnboarding).toBe(true);

    await runtime({}).configure(configDir);
    expect(JSON.parse(fs.readFileSync(path.join(configDir, "settings.json"), "utf8"))).toEqual({ model: "claude-opus-5-5", attribution: { commit: "", pr: "" } });
    expect(fs.readFileSync(path.join(configDir, "achq-system-prompt.md"), "utf8")).toBe("Runner prompt.\n");
  });
});

describe("run", () => {
  const context = (root: string, over: Partial<RunContext> = {}): RunContext => {
    const cwd = path.join(root, "wt");
    fs.mkdirSync(cwd, { recursive: true });
    return {
      thread: { channel: "test", id: "o/r#1" },
      cwd,
      configDir: path.join(root, "agents/coder"),
      env: { PATH: process.env.PATH!, FAKE_CLAUDE_LOG: path.join(root, "calls"), CLAUDE_CODE_OAUTH_TOKEN: "oauth" },
      prompt: "do the thing",
      session: { new: "11111111-1111-1111-1111-111111111111" },
      signal: new AbortController().signal,
      log: () => {},
      ...over,
    };
  };

  test("runs claude headless with the session, system prompt and denials, returning the result", async () => {
    const { root, runtime, claude } = setup();
    const r = runtime({ effort: "max", systemPrompt: "./prompts/system.md" });
    const ctx = context(root);
    await r.configure(ctx.configDir);
    expect(await r.run(ctx)).toEqual({ reply: "Reply for 11111111-1111-1111-1111-111111111111" });
    const [call] = claude.calls();
    expect(call!.argv.slice(0, 4)).toEqual(["-p", "--output-format=stream-json", "--verbose", "--dangerously-skip-permissions"]);
    expect(call!.argv).toContain("--session-id=11111111-1111-1111-1111-111111111111");
    expect(call!.argv.join(" ")).toContain("--effort max");
    expect(call!.argv.slice(-DENIED.length - 1)).toEqual(["--disallowedTools", ...DENIED]);
    expect(call!.stdin).toBe("do the thing");
    expect(call!.cwd).toBe(ctx.cwd);
    expect(call!.env.CLAUDE_CONFIG_DIR).toBe(ctx.configDir);
    expect(call!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth");
    // The worktree is trusted for an interactive resume.
    expect(JSON.parse(fs.readFileSync(path.join(ctx.configDir, ".claude.json"), "utf8")).projects[ctx.cwd].hasTrustDialogAccepted).toBe(true);

    // Resuming needs the transcript, which the first run left.
    expect(await r.run(context(root, { session: { resume: "11111111-1111-1111-1111-111111111111" } }))).toEqual({ reply: "Reply for 11111111-1111-1111-1111-111111111111" });
    expect(claude.calls()[1]!.argv).toContain("--resume=11111111-1111-1111-1111-111111111111");
    const missing = await r.run(context(root, { session: { resume: "22222222-2222-2222-2222-222222222222" } }));
    expect(missing.error).toContain("missing from the volume");
  });

  test("reports a failing claude with its stderr, and stops one that runs past its timeout", async () => {
    const { root, runtime } = setup();
    const r = runtime({});
    const failing = context(root);
    failing.env.FAKE_CLAUDE_FAIL = "out of disk";
    const failed = await r.run(failing);
    expect(failed.error).toContain("claude exited with 3");
    expect(failed.error).toContain("boom: out of disk");

    const slow = context(root, { signal: AbortSignal.timeout(200) });
    slow.env.FAKE_CLAUDE_DELAY_MS = "5000";
    const started = Date.now();
    const timedOut = await r.run(slow);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(timedOut.error).toContain("timed out");
  });

  test("resumeCommand opens the session interactively with the agent's config", () => {
    const { root, runtime, ctx } = setup();
    const cmd = runtime({ effort: "max" }).resumeCommand("abc", path.join(root, "agents/coder"));
    expect(cmd.argv[0]).toBe(ctx.env.ACHQ_CLAUDE_BIN!);
    expect(cmd.argv).toContain("--resume=abc");
    expect(cmd.argv).not.toContain("-p");
    expect(cmd.argv.join(" ")).toContain("--effort max");
    expect(cmd.env.CLAUDE_CONFIG_DIR).toBe(path.join(root, "agents/coder"));
  });
});
