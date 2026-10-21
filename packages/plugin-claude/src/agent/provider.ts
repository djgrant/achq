import * as path from "node:path";
import type { Agent as CoreAgent, AgentProvider, AgentRuntime, RunContext, RuntimeContext } from "@achq/core";
import { crypto } from "@achq/utils/crypto";
import { disk } from "@achq/utils/disk";
import { json } from "@achq/utils/json";
import { subprocess } from "@achq/utils/subprocess";
import { text } from "@achq/utils/text";
import { claudeSettings, effortFlags, resolveStartupPath, transcriptExists, updateClaudeJson } from "../lib/config-dir.ts";
import { BIN_ENV, CLAUDE_ENV, DENIED, RUNTIME, SETTINGS_FILE, SYSTEM_PROMPT_FILE, TOKEN_ENV } from "../lib/constants.ts";
import { ClaudeStream } from "../lib/stream.ts";
import type { Agent } from "./resource.ts";

const DEFAULT_BIN = "claude";
/** A run's flags that an interactive `resume` leaves out: print mode, streaming JSON, no permission prompts. */
const HEADLESS_FLAGS = ["-p", "--output-format=stream-json", "--verbose", "--dangerously-skip-permissions"];
const STDERR_TAIL_LINES = 40;
const RESUME_THEME = "dark";

export class ClaudeAgentProvider implements AgentProvider {
  readonly id = RUNTIME;
  readonly containerEnv = [{ name: TOKEN_ENV, hint: "Run `claude setup-token`." }];

  /** A field, not a method: the container lists it by id, apart from the provider. */
  readonly runtime = (coreAgent: CoreAgent, ctx: RuntimeContext): AgentRuntime => {
    const agent = coreAgent as Agent;
    const config = agent.config;
    const claude = ctx.env[BIN_ENV] || DEFAULT_BIN;
    const repoPrompt = config.systemPrompt ? ctx.readFile(config.systemPrompt) : "";
    const systemPrompt = [ctx.runnerPrompt.trim(), repoPrompt.trim()].filter(Boolean).join("\n\n") + "\n";
    const agentFiles = ctx.resolveFiles(config.files);
    const promptFile = (configDir: string) => path.join(configDir, SYSTEM_PROMPT_FILE);
    const claudeEnv = (configDir: string) => ({ CLAUDE_CONFIG_DIR: configDir, ...CLAUDE_ENV });
    const argv = (configDir: string, session: RunContext["session"], headless: boolean) => [
      claude,
      ...(headless ? HEADLESS_FLAGS : []),
      `--append-system-prompt-file=${promptFile(configDir)}`,
      "new" in session ? `--session-id=${session.new}` : `--resume=${session.resume}`,
      ...effortFlags(config),
      "--disallowedTools",
      ...DENIED,
    ];

    return {
      name: agent.name,

      async sessionKey() {
        const prefix = {
          // Named `kind` so existing session keys still match.
          kind: RUNTIME,
          name: agent.name,
          config: json.from(config, `agent ${agent.name} config`),
          systemPrompt,
          containerFiles: ctx.containerFiles,
          agentFiles,
        };
        return crypto.sha256Hex(json.stableStringify(prefix));
      },

      async configure(configDir) {
        disk.ensureDir(configDir);
        for (const [key, content] of Object.entries(agentFiles)) disk.writeEnsured(resolveStartupPath(key, ctx.home, configDir), content);
        disk.writeJsonSync(path.join(configDir, SETTINGS_FILE), claudeSettings(config), { pretty: true });
        disk.writeEnsured(promptFile(configDir), systemPrompt);
        // The first interactive start asks for a theme; `resume` shouldn't.
        updateClaudeJson(configDir, (c) => {
          c.hasCompletedOnboarding = true;
          c.theme ??= RESUME_THEME;
        });
      },

      async run(context) {
        const { configDir, session, cwd, log, signal } = context;
        if ("resume" in session && !transcriptExists(configDir, session.resume)) {
          return { reply: "", error: `The transcript for session \`${session.resume}\` is missing from the volume.` };
        }
        // `resume` opens this worktree interactively; don't ask whether to trust it.
        updateClaudeJson(configDir, (c) => {
          c.projects ??= {};
          c.projects[cwd] = { ...c.projects[cwd], hasTrustDialogAccepted: true };
        });

        const stream = new ClaudeStream();
        const proc = await subprocess.collect(argv(configDir, session, true), {
          cwd,
          env: { ...context.env, ...claudeEnv(configDir) },
          input: context.prompt,
          signal,
          onLine: (line) => stream.read(line, log),
        });
        const stderr = proc.stderr.trim();
        if (stderr) log(stderr);

        const failure = stream.failure(proc, signal);
        if (failure) return { reply: "", error: [failure, ...text.tailLines(stderr, STDERR_TAIL_LINES)].join("\n") };
        return { reply: stream.reply(context.prompt) };
      },

      resumeCommand(session, configDir) {
        return { argv: argv(configDir, { resume: session }, false), env: claudeEnv(configDir) };
      },
    };
  };
}
