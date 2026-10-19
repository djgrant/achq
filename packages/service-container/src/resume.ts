import { threadKey as keyOf, type RuntimeFactory } from "@achq/core";
import { BUSY, lockedArgv } from "@achq/flock";
import { savedAgentEnv } from "./agent-env.ts";
import type { LoadedConfig } from "./config/loader.ts";
import { withoutPrivate } from "./env.ts";
import { resolveFiles } from "./files.ts";
import { keepAwake, stayAwake } from "./keep-awake.ts";
import type { Paths } from "./paths.ts";
import { runnerPrompt } from "./runner-prompt.ts";
import { runtimeContext } from "./runtime-context.ts";
import { defaultRuntimes } from "./runtimes.ts";
import { sessionsFor } from "./sessions.ts";

export type ResumeOptions = {
  paths: Paths;
  number: string;
  /** The session's exact ID. */
  session: string;
  loadConfig: (commit: string) => Promise<LoadedConfig>;
  container: string;
  runtimes?: Record<string, RuntimeFactory>;
  env?: Record<string, string | undefined>;
  /** Defaults to inheriting the terminal. */
  stdio?: ["inherit" | "ignore", "inherit" | "ignore", "inherit" | "ignore"];
  out?: (text: string) => void;
};

/**
 * Opens a thread's session interactively in its worktree, holding the
 * thread's lock so the agent's next run waits until you exit. Fails if a run
 * is in progress. Returns the exit status. Run over SSH by the laptop CLI,
 * which picks the session.
 */
export const resume = async (opts: ResumeOptions): Promise<number> => {
  const out = opts.out ?? ((text) => console.error(text));
  const sessions = sessionsFor(opts.paths, opts.number);
  const session = sessions.find((s) => s.id === opts.session);
  if (!session) {
    out(`No session ${opts.session} on thread ${opts.number}`);
    return 1;
  }
  const config = await opts.loadConfig(session.commit);
  const agent = config.agents.find((a) => a.name === session.agent);
  const factory = agent && (opts.runtimes ?? defaultRuntimes)[agent.runtime];
  if (!agent || !factory) throw new Error(`Agent ${session.agent} isn't in the config at ${session.commit}`);
  const container = config.plan.containers.find((c) => c.name === opts.container);
  const runtime = factory(agent, runtimeContext(config.root, {
    home: opts.paths.home,
    runnerPrompt: runnerPrompt(),
    containerFiles: resolveFiles(container?.files, config.root),
    env: withoutPrivate(opts.env ?? process.env),
  }));
  const configDir = opts.paths.agent(agent.name);
  await runtime.configure(configDir);
  const command = runtime.resumeCommand(session.id, configDir);
  const threadKey = keyOf(session.state.thread);

  const proc = Bun.spawn(lockedArgv(opts.paths.lock(session.workspace, threadKey), command.argv), {
    cwd: opts.paths.worktree(session.workspace, threadKey),
    env: { ...withoutPrivate(opts.env ?? process.env), HOME: opts.paths.home, ...savedAgentEnv(opts.paths.agentEnv), ...command.env },
    stdio: opts.stdio ?? ["inherit", "inherit", "inherit"],
  });
  // A dropped SSH connection doesn't always reach the agent, which would then
  // hold the lock forever. Stop it when our parent (the SSH shell) goes away.
  const parent = process.ppid;
  const orphaned = setInterval(() => process.ppid !== parent && proc.kill("SIGHUP"), 1000);
  // An idle session makes no outbound traffic.
  const ping = keepAwake(opts.env ?? process.env);
  const stopPinging = ping ? stayAwake(() => ping().catch(() => {})) : () => {};
  const forward = (signal: NodeJS.Signals) => () => proc.kill(signal);
  const handlers = (["SIGHUP", "SIGTERM"] as const).map((signal) => [signal, forward(signal)] as const);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const code = await proc.exited;
  clearInterval(orphaned);
  stopPinging();
  for (const [signal, handler] of handlers) process.off(signal, handler);
  if (code === BUSY) {
    out(`An agent is working on this thread in ${session.workspace}. Try again when its run finishes.`);
    return BUSY;
  }
  return code;
};
