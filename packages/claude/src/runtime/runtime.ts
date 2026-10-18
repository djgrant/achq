import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { stableStringify, toData, type AgentRuntime, type RunContext, type RunResult, type RuntimeContext } from "@achq/core";
import { CLAUDE_ENV, DENIED, SETTINGS_FILE, SYSTEM_PROMPT_FILE } from "../constants.ts";
import type { Claude } from "../resources.ts";
import { transcriptExists, updateClaudeJson, writeFiles } from "./config-dir.ts";
import { claudeSettings, effortFlags } from "./settings.ts";
import { eachLine, StreamStats, tokens } from "./stream.ts";

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
      fs.writeFileSync(path.join(configDir, SETTINGS_FILE), `${JSON.stringify(claudeSettings(config), null, 2)}\n`);
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
      const env = { ...context.env, CLAUDE_CONFIG_DIR: configDir, ...CLAUDE_ENV };
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
        env: { CLAUDE_CONFIG_DIR: configDir, ...CLAUDE_ENV },
      };
    },
  };
};
