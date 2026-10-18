import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { stableStringify, toData, type AgentRuntime, type RunContext, type RunResult, type RuntimeContext } from "@achq/core";
import type { Claude, ClaudeConfig } from "./resources.ts";

export const DEFAULT_MODEL = "claude-opus-5-5";

/**
 * The agent only sees the trusted context the runner gives it. These commands
 * could read anyone's thread content, so they're denied. Commenting is denied
 * because the runner posts the reply.
 */
export const DENIED = ["Bash(gh issue view:*)", "Bash(gh issue list:*)", "Bash(gh issue comment:*)", "Bash(gh api:*)", "Bash(gh search:*)"];

/** Effort levels `settings.json` can persist. `max` is per session only, so it's a flag. */
const PERSISTED_EFFORT = new Set(["low", "medium", "high", "xhigh"]);

const SYSTEM_PROMPT_FILE = "achq-system-prompt.md";

/** `settings.json`: achq's defaults, then the repo's settings on top. */
export const claudeSettings = (config: ClaudeConfig): Record<string, unknown> => ({
  model: config.model ?? DEFAULT_MODEL,
  ...(config.effort && PERSISTED_EFFORT.has(config.effort) && { effortLevel: config.effort }),
  attribution: { commit: "", pr: "" },
  ...config.settings,
});

/** Flags for config that settings.json can't hold. */
const effortFlags = (config: ClaudeConfig) => (config.effort === "max" ? ["--effort", "max"] : []);

export const claudeRuntime = (agent: Claude, ctx: RuntimeContext): AgentRuntime => {
  const config = agent.config;
  const claude = ctx.bin.claude ?? "claude";
  const repoPrompt = config.systemPrompt ? ctx.readFile(config.systemPrompt) : "";
  const systemPrompt = [ctx.runnerPrompt.trim(), repoPrompt.trim()].filter(Boolean).join("\n\n") + "\n";
  const agentFiles = ctx.resolveFiles(config.files);
  const promptFile = (configDir: string) => path.join(configDir, SYSTEM_PROMPT_FILE);

  return {
    name: agent.name,

    async sessionKey() {
      const prefix = {
        kind: "claude",
        name: agent.name,
        config: toData(config, `agent ${agent.name} config`),
        systemPrompt,
        containerFiles: ctx.containerFiles,
        agentFiles,
      };
      return createHash("sha256").update(stableStringify(prefix)).digest("hex");
    },

    async configure(configDir) {
      fs.mkdirSync(configDir, { recursive: true });
      writeFiles(agentFiles, ctx.home, configDir);
      fs.writeFileSync(path.join(configDir, "settings.json"), `${JSON.stringify(claudeSettings(config), null, 2)}\n`);
      fs.writeFileSync(promptFile(configDir), systemPrompt);
      updateClaudeJson(configDir, (c) => {
        // The first interactive start asks for a theme; `resume` shouldn't.
        c.hasCompletedOnboarding = true;
        c.theme ??= "dark";
      });
    },

    async run(context: RunContext): Promise<RunResult> {
      const { configDir, session, cwd, log } = context;
      if ("resume" in session && !transcriptExists(configDir, session.resume)) {
        return { reply: "", error: `The transcript for session \`${session.resume}\` is missing from the volume.` };
      }
      // `resume` opens this worktree interactively; don't ask whether to trust it.
      updateClaudeJson(configDir, (c) => {
        c.projects ??= {};
        c.projects[cwd] = { ...c.projects[cwd], hasTrustDialogAccepted: true };
      });

      const argv = [
        claude,
        "-p",
        "--output-format=stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        `--append-system-prompt-file=${promptFile(configDir)}`,
        "new" in session ? `--session-id=${session.new}` : `--resume=${session.resume}`,
        ...effortFlags(config),
        "--disallowedTools",
        ...DENIED,
      ];
      const env = { ...context.env, CLAUDE_CONFIG_DIR: configDir, DISABLE_AUTOUPDATER: "1" };
      const proc = Bun.spawn(argv, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      const stop = () => proc.kill();
      if (context.signal.aborted) stop();
      context.signal.addEventListener("abort", stop);
      proc.stdin.write(context.prompt);
      proc.stdin.end();

      const stats = new StreamStats();
      const [, errors, exitCode] = await Promise.all([
        eachLine(proc.stdout, (line) => {
          let event: any;
          try {
            event = JSON.parse(line);
          } catch {
            return log(line);
          }
          stats.push(event);
          for (const block of event.type === "assistant" ? (event.message?.content ?? []) : []) {
            if (block.type === "tool_use") log(`→ ${block.name} ${JSON.stringify(block.input).slice(0, 200)}`);
            if (block.type === "text") log(String(block.text).slice(0, 500));
          }
        }),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      context.signal.removeEventListener("abort", stop);
      const stderr = errors.trim().split("\n").filter(Boolean).slice(-40);
      if (stderr.length) log(errors.trim());

      if (exitCode !== 0 || stats.result?.is_error) {
        const detail = stats.result?.is_error
          ? `${stats.result.subtype}: ${stats.result.result ?? stats.result.errors?.join("\n") ?? ""}`
          : context.signal.aborted
            ? "The run timed out and was stopped."
            : `claude exited with ${proc.signalCode ?? exitCode}`;
        return { reply: "", error: [detail, ...stderr].join("\n") };
      }
      if (stats.compacted && context.prompt.startsWith("/compact")) {
        return { reply: `Compacted the session: ${tokens(stats.compacted.pre)} → ${tokens(stats.compacted.post)} tokens.` };
      }
      return { reply: stats.result?.result?.trim() || "Claude finished without a reply." };
    },

    resumeCommand(session, configDir) {
      return {
        argv: [claude, `--append-system-prompt-file=${promptFile(configDir)}`, `--resume=${session}`, ...effortFlags(config), "--disallowedTools", ...DENIED],
        env: { CLAUDE_CONFIG_DIR: configDir, DISABLE_AUTOUPDATER: "1" },
      };
    },
  };
};

/** `~/.claude/…` goes in the agent's own config directory. Other files go where the container would put them. */
const writeFiles = (resolved: Record<string, string>, home: string, configDir: string) => {
  for (const [key, content] of Object.entries(resolved)) {
    const file =
      key === "~/.claude" || key.startsWith("~/.claude/")
        ? path.join(configDir, key.slice("~/.claude".length))
        : key.startsWith("~/")
          ? path.join(home, key.slice(2))
          : path.isAbsolute(key)
            ? key
            : path.join(home, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
};

const updateClaudeJson = (configDir: string, fn: (config: any) => void) => {
  const file = path.join(configDir, ".claude.json");
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  fn(config);
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
};

export const transcriptExists = (configDir: string, session: string) => {
  const projects = path.join(configDir, "projects");
  return fs.existsSync(projects) && new Bun.Glob(`*/${session}.jsonl`).scanSync(projects).next().done === false;
};

/** Context and usage figures gathered from Claude's stream-json output. */
export class StreamStats {
  session?: string;
  context?: number;
  window?: number;
  turns?: number;
  compacted?: { pre: number; post: number };
  result?: { is_error: boolean; subtype: string; result?: string; errors?: string[] };

  push(event: any) {
    if (event.session_id) this.session = event.session_id;
    if (event.type === "assistant" && !event.parent_tool_use_id && event.message?.usage) {
      const u = event.message.usage;
      this.context = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
    } else if (event.type === "system" && event.subtype === "compact_boundary") {
      const { pre_tokens, post_tokens } = event.compact_metadata;
      this.context = post_tokens;
      this.compacted = { pre: pre_tokens, post: post_tokens };
    } else if (event.type === "result") {
      this.result = event;
      this.turns = event.num_turns;
      const windows = Object.values(event.modelUsage ?? {}).map((m: any) => m.contextWindow ?? 0);
      if (windows.length) this.window = Math.max(...windows);
    }
  }
}

export const tokens = (n: number): string =>
  n >= 1_000_000 ? `${Math.floor(n / 100_000) / 10}M` : n >= 1000 ? `${Math.floor(n / 1000)}k` : `${n}`;

const eachLine = async (stream: ReadableStream<Uint8Array>, fn: (line: string) => void) => {
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
