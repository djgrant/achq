import { randomUUID } from "node:crypto";
import { type ChannelClient, type ChannelEvent, type RepoManifest, type RuntimeContext, type RuntimeFactory, type Thread, threadKey } from "@achq/core";
import { parseCommand, type Command } from "./command.ts";
import type { LoadedConfig } from "./config/loader.ts";
import type { Paths } from "./paths.ts";
import { buildPrompt } from "./prompt.ts";
import { reply } from "./reply.ts";
import { describeHead } from "./repo.ts";
import { type ThreadState, writeState } from "./state.ts";

type Trigger = RepoManifest["triggers"][number];

export type TriggerRun = {
  trigger: Trigger;
  event: ChannelEvent;
  config: LoadedConfig;
  ctx: RuntimeContext;
  client: ChannelClient;
  thread: Thread;
  state: ThreadState;
  cwd: string;
  env: Record<string, string>;
  log: (line: string) => void;
};

export type TriggerDeps = {
  paths: Paths;
  runtimes: Record<string, RuntimeFactory>;
  runTimeoutMs: number;
  now: () => number;
};

/** Runs the trigger's agent on the thread, in a new or resumed session, and posts its reply. */
export const runTrigger = async (deps: TriggerDeps, r: TriggerRun) => {
  const { trigger, event, config, client, thread, state, cwd, log } = r;
  const agent = config.agents.find((a) => a.name === trigger.agent);
  const factory = agent && deps.runtimes[agent.runtime];
  if (!agent || !factory) return reply(client, thread.ref, `⚠️ Trigger \`${trigger.name}\` names agent \`${trigger.agent}\`, which this container can't run.`, log);

  const mention = typeof trigger.event.mention === "string" ? trigger.event.mention : undefined;
  const command: Command = mention && event.text ? parseCommand(event.text, mention) : { mode: "resume", text: "" };
  const stateFile = deps.paths.thread(threadKey(thread.ref));
  const configDir = deps.paths.agent(agent.name);
  const hint = mention ? `\n\nComment \`${mention} <prompt>\` to resume the session, or \`${mention} /new <prompt>\` to start over.` : "";

  try {
    const runtime = factory(agent, r.ctx);
    const sessionKey = await runtime.sessionKey();
    const previous = state.sessions[agent.name];
    const fresh = command.mode === "new" || !previous || previous.key !== sessionKey;
    if (command.mode === "compact" && fresh) throw new Error("There is no current session on this thread to compact.");

    let prompt: string;
    let lastMessage = previous?.lastMessage;
    let opening = previous?.opening;
    if (command.mode === "compact") {
      prompt = `/compact ${command.text}`.trim();
    } else {
      const messages = await client.messages(thread.ref);
      const built = buildPrompt({
        mode: fresh ? "new" : "resume",
        thread,
        messages,
        since: previous?.lastMessage,
        opening: previous?.opening,
        mention,
        ...(event.previousText !== undefined && event.message && { edited: event.message }),
        by: event.actor!.login,
        ...(await describeHead(cwd)),
      });
      // An earlier run already picked this up along with other messages.
      if (!fresh && built.included === 0) return log(`${agent.name}: nothing new since the last run; skipping`);
      prompt = built.prompt;
      lastMessage = built.lastMessage;
      opening = built.opening;
    }

    const id = fresh ? randomUUID() : previous!.id;
    state.sessions[agent.name] = { key: sessionKey, id, lastMessage, opening, status: "running", lastRun: new Date(deps.now()).toISOString(), commit: config.commit };
    writeState(stateFile, state);
    log(`${agent.name}: ${fresh ? "new" : "resumed"} session ${id} (trigger ${trigger.name})`);

    await runtime.configure(configDir);
    const result = await runtime.run({
      thread: thread.ref,
      cwd,
      configDir,
      env: r.env,
      prompt,
      session: fresh ? { new: id } : { resume: id },
      signal: AbortSignal.timeout(deps.runTimeoutMs),
      log: (line) => log(`${agent.name}: ${line}`),
    });
    state.sessions[agent.name]!.status = "idle";
    writeState(stateFile, state);
    const message = result.error
      ? `⚠️ **The run failed.**\n\n<details><summary>Error output</summary>\n\n\`\`\`\n${result.error}\n\`\`\`\n\n</details>${hint}`
      : result.reply;
    await reply(client, thread.ref, message, log);
  } catch (e) {
    log(`${agent.name}: ${e instanceof Error ? e.stack : e}`);
    const session = state.sessions[agent.name];
    if (session?.status === "running") {
      session.status = "idle";
      writeState(stateFile, state);
    }
    await reply(client, thread.ref, `⚠️ ${e instanceof Error ? e.message : String(e)}`, log);
  }
};
