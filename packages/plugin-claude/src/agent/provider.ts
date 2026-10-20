// Claude Code as an agent runtime: each agent gets its own config directory,
// and each run is a headless `claude -p` in the thread's worktree.
import * as path from "node:path";
import { type Agent as CoreAgent, type AgentProvider, type AgentRuntime, type RunContext, type RunResult, type RuntimeContext, stableStringify, toData } from "@achq/core";
import { sha256Hex } from "@achq/utils/crypto";
import { ensureDir, writeFileEnsured, writeJsonSync } from "@achq/utils/fs";
import { type Collected, spawnCollect } from "@achq/utils/process";
import { claudeSettings, effortFlags, transcriptExists, updateClaudeJson, writeFiles } from "../lib/config-dir.ts";
import { BIN_ENV, CLAUDE_ENV, DENIED, RUNTIME, SETTINGS_FILE, SYSTEM_PROMPT_FILE, TOKEN_ENV } from "../lib/constants.ts";
import { StreamStats, tokens } from "../lib/stream.ts";
import type { Agent, AgentConfig } from "./resource.ts";

type Session = RunContext["session"];
type Log = (line: string) => void;

const DEFAULT_BIN = "claude";
/** A run's flags that an interactive `resume` leaves out: print mode, streaming JSON, no permission prompts. */
const HEADLESS_FLAGS = ["-p", "--output-format=stream-json", "--verbose", "--dangerously-skip-permissions"];
const COMPACT_COMMAND = "/compact";
/** How much of a tool call's input, and of the agent's text, goes in the log. */
const TOOL_INPUT_LOG_CHARS = 200;
const TEXT_LOG_CHARS = 500;
/** How much of claude's stderr goes in a failed run's error. */
const STDERR_TAIL_LINES = 40;
const NO_REPLY = "Claude finished without a reply.";
const TIMED_OUT = "The run timed out and was stopped.";
const RESUME_THEME = "dark";

export class ClaudeAgentProvider implements AgentProvider {
  readonly id = RUNTIME;
  readonly containerEnv = [{ name: TOKEN_ENV, hint: "Run `claude setup-token`." }];

  /** A field, not a method: the container lists it by id, apart from the provider. */
  readonly runtime = (agent: CoreAgent, ctx: RuntimeContext) => agentRuntime(agent as Agent, ctx);
}

const agentRuntime = (agent: Agent, ctx: RuntimeContext): AgentRuntime => {
  const config = agent.config;
  const claude = ctx.env[BIN_ENV] || DEFAULT_BIN;
  const repoPrompt = config.systemPrompt ? ctx.readFile(config.systemPrompt) : "";
  const systemPrompt = [ctx.runnerPrompt.trim(), repoPrompt.trim()].filter(Boolean).join("\n\n") + "\n";
  const agentFiles = ctx.resolveFiles(config.files);
  const argv = (configDir: string, session: Session, headless: boolean) => claudeArgv(claude, configDir, session, config, headless);

  return {
    name: agent.name,

    async sessionKey() {
      const prefix = {
        // Named `kind` so existing session keys still match.
        kind: RUNTIME,
        name: agent.name,
        config: toData(config, `agent ${agent.name} config`),
        systemPrompt,
        containerFiles: ctx.containerFiles,
        agentFiles,
      };
      return sha256Hex(stableStringify(prefix));
    },

    async configure(configDir) {
      ensureDir(configDir);
      writeFiles(agentFiles, ctx.home, configDir);
      writeJsonSync(path.join(configDir, SETTINGS_FILE), claudeSettings(config), { pretty: true });
      writeFileEnsured(promptFile(configDir), systemPrompt);
      skipOnboarding(configDir);
    },

    async run(context: RunContext): Promise<RunResult> {
      const { configDir, session, cwd, log, signal } = context;
      if ("resume" in session && !transcriptExists(configDir, session.resume)) {
        return { reply: "", error: `The transcript for session \`${session.resume}\` is missing from the volume.` };
      }
      trustWorktree(configDir, cwd);

      const stats = new StreamStats();
      const proc = await spawnCollect(argv(configDir, session, true), {
        cwd,
        env: { ...context.env, ...claudeEnv(configDir) },
        input: context.prompt,
        signal,
        onLine: (line) => readStreamLine(line, stats, log),
      });
      const stderr = proc.stderr.trim();
      if (stderr) log(stderr);

      const failure = failureDetail(stats, signal, proc);
      if (failure) return { reply: "", error: [failure, ...tailLines(stderr, STDERR_TAIL_LINES)].join("\n") };
      return { reply: replyFor(stats, context.prompt) };
    },

    resumeCommand(session, configDir) {
      return { argv: argv(configDir, { resume: session }, false), env: claudeEnv(configDir) };
    },
  };
};

const promptFile = (configDir: string) => path.join(configDir, SYSTEM_PROMPT_FILE);

/** `claude`'s argv for a session: headless for a run, interactive for `resume`. */
const claudeArgv = (claude: string, configDir: string, session: Session, config: AgentConfig, headless: boolean) => [
  claude,
  ...(headless ? HEADLESS_FLAGS : []),
  `--append-system-prompt-file=${promptFile(configDir)}`,
  "new" in session ? `--session-id=${session.new}` : `--resume=${session.resume}`,
  ...effortFlags(config),
  "--disallowedTools",
  ...DENIED,
];

const claudeEnv = (configDir: string) => ({ CLAUDE_CONFIG_DIR: configDir, ...CLAUDE_ENV });

/** The first interactive start asks for a theme; `resume` shouldn't. */
const skipOnboarding = (configDir: string) =>
  updateClaudeJson(configDir, (c) => {
    c.hasCompletedOnboarding = true;
    c.theme ??= RESUME_THEME;
  });

/** `resume` opens this worktree interactively; don't ask whether to trust it. */
const trustWorktree = (configDir: string, cwd: string) =>
  updateClaudeJson(configDir, (c) => {
    c.projects ??= {};
    c.projects[cwd] = { ...c.projects[cwd], hasTrustDialogAccepted: true };
  });

/** One line of stream-json: counted, and logged readably. A line that isn't JSON is logged as it is. */
const readStreamLine = (line: string, stats: StreamStats, log: Log) => {
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return log(line);
  }
  stats.push(event);
  logEvent(event, log);
};

/** The assistant's tool calls and text, shortened. */
const logEvent = (event: any, log: Log) => {
  if (event.type !== "assistant") return;
  for (const block of event.message?.content ?? []) {
    if (block.type === "tool_use") log(`→ ${block.name} ${JSON.stringify(block.input).slice(0, TOOL_INPUT_LOG_CHARS)}`);
    if (block.type === "text") log(String(block.text).slice(0, TEXT_LOG_CHARS));
  }
};

/** Why the run failed, or undefined if it didn't: Claude's own error, the timeout, or the exit status. */
const failureDetail = (stats: StreamStats, signal: AbortSignal, proc: Collected): string | undefined => {
  const result = stats.result;
  if (result?.is_error) return `${result.subtype}: ${result.result ?? result.errors?.join("\n") ?? ""}`;
  if (proc.exitCode === 0) return undefined;
  if (signal.aborted) return TIMED_OUT;
  return `claude exited with ${proc.signalCode ?? proc.exitCode}`;
};

/** The reply to post: the compaction's effect for `/compact`, otherwise Claude's result. */
const replyFor = (stats: StreamStats, prompt: string) => {
  if (stats.compacted && prompt.startsWith(COMPACT_COMMAND)) return `Compacted the session: ${tokens(stats.compacted.pre)} → ${tokens(stats.compacted.post)} tokens.`;
  return stats.result?.result?.trim() || NO_REPLY;
};

/** The last `n` non-blank lines of `text`. */
const tailLines = (text: string, n: number) => text.split("\n").filter(Boolean).slice(-n);
