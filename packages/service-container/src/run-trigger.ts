import { randomUUID } from "node:crypto";
import {
  type Agent,
  type AgentRuntime,
  type ChannelClient,
  type ChannelEvent,
  type RepoManifest,
  type RuntimeContext,
  type RuntimeFactory,
  type Thread,
  threadKey,
} from "@achq/core";
import { errorDetail, errorMessage } from "@achq/utils/errors";
import { parseCommand, type Command } from "./command.ts";
import type { LoadedConfig } from "./config/loader.ts";
import { failureReply, NOTHING_TO_COMPACT, runFailed, unrunnableAgent } from "./messages.ts";
import type { Paths } from "./paths.ts";
import { buildPrompt } from "./prompt.ts";
import { reply } from "./reply.ts";
import { describeHead } from "./repo.ts";
import { type SessionState, type ThreadState, writeState } from "./state.ts";

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

type SessionPlan = { fresh: boolean; id: string; key: string; previous?: SessionState };

type PromptPlan = { prompt: string; lastMessage?: string; opening?: string };

/** A command with nothing to say, for runs not started by a mention. */
const RESUME: Command = { mode: "resume", text: "" };

export const runTrigger = async (deps: TriggerDeps, run: TriggerRun) => {
  const { trigger, client, thread, log } = run;
  const resolved = resolveRuntime(deps, run.config, trigger);
  if (!resolved) return reply(client, thread.ref, unrunnableAgent(trigger), log);
  const { agent, factory } = resolved;
  const mention = mentionOf(trigger);
  const command = mention && run.event.text ? parseCommand(run.event.text, mention) : RESUME;
  const agentLog = (line: string) => log(`${agent.name}: ${line}`);

  try {
    const runtime = factory(agent, run.ctx);
    const plan = planSession(run.state, agent.name, command, await runtime.sessionKey());
    const prompt = await promptFor(run, plan, command, mention);
    // An earlier run already picked this up along with other messages.
    if (!prompt) return agentLog("nothing new since the last run; skipping");

    startSession(deps, run, agent.name, plan, prompt);
    agentLog(`${plan.fresh ? "new" : "resumed"} session ${plan.id} (trigger ${trigger.name})`);
    const result = await runAgent(deps, run, runtime, agent.name, plan, prompt.prompt, agentLog);
    finishSession(deps, run, agent.name);
    await reply(client, thread.ref, result.error ? runFailed(result.error, mention) : result.reply, log);
  } catch (e) {
    agentLog(errorDetail(e));
    finishSession(deps, run, agent.name);
    await reply(client, thread.ref, failureReply(errorMessage(e)), log);
  }
};

const resolveRuntime = (deps: TriggerDeps, config: LoadedConfig, trigger: Trigger): { agent: Agent; factory: RuntimeFactory } | undefined => {
  const agent = config.agents.find((a) => a.name === trigger.agent);
  const factory = agent && deps.runtimes[agent.runtime];
  return agent && factory ? { agent, factory } : undefined;
};

const mentionOf = (trigger: Trigger) => (typeof trigger.event.mention === "string" ? trigger.event.mention : undefined);

/** `/new`, no session yet, or a changed session key start afresh. Compacting needs a session to compact. */
const planSession = (state: ThreadState, agent: string, command: Command, key: string): SessionPlan => {
  const previous = state.sessions[agent];
  const fresh = command.mode === "new" || !previous || previous.key !== key;
  if (command.mode === "compact" && fresh) throw new Error(NOTHING_TO_COMPACT);
  return { fresh, id: fresh ? randomUUID() : previous!.id, key, previous };
};

/** The prompt for this run, or undefined when a resumed session has nothing new to see. */
const promptFor = async (run: TriggerRun, plan: SessionPlan, command: Command, mention: string | undefined): Promise<PromptPlan | undefined> => {
  const { previous } = plan;
  if (command.mode === "compact") return { prompt: `/compact ${command.text}`.trim(), lastMessage: previous?.lastMessage, opening: previous?.opening };
  const { event, thread } = run;
  const built = buildPrompt({
    mode: plan.fresh ? "new" : "resume",
    thread,
    messages: await run.client.messages(thread.ref),
    since: previous?.lastMessage,
    opening: previous?.opening,
    mention,
    ...(event.previousText !== undefined && event.message && { edited: event.message }),
    by: event.actor!.login,
    ...(await describeHead(run.cwd)),
  });
  if (!plan.fresh && built.included === 0) return undefined;
  return built;
};

const saveState = (deps: TriggerDeps, run: TriggerRun) => writeState(deps.paths.thread(threadKey(run.thread.ref)), run.state);

/** So a restart mid-run can say so. */
const startSession = (deps: TriggerDeps, run: TriggerRun, agent: string, plan: SessionPlan, prompt: PromptPlan) => {
  run.state.sessions[agent] = {
    key: plan.key,
    id: plan.id,
    lastMessage: prompt.lastMessage,
    opening: prompt.opening,
    status: "running",
    lastRun: new Date(deps.now()).toISOString(),
    commit: run.config.commit,
  };
  saveState(deps, run);
};

const finishSession = (deps: TriggerDeps, run: TriggerRun, agent: string) => {
  const session = run.state.sessions[agent];
  if (session?.status !== "running") return;
  session.status = "idle";
  saveState(deps, run);
};

const runAgent = async (deps: TriggerDeps, run: TriggerRun, runtime: AgentRuntime, agent: string, plan: SessionPlan, prompt: string, log: (line: string) => void) => {
  const configDir = deps.paths.agent(agent);
  await runtime.configure(configDir);
  return runtime.run({
    thread: run.thread.ref,
    cwd: run.cwd,
    configDir,
    env: run.env,
    prompt,
    session: plan.fresh ? { new: plan.id } : { resume: plan.id },
    signal: AbortSignal.timeout(deps.runTimeoutMs),
    log,
  });
};
