import { type AgentRuntime, threadKey as keyOf, type RuntimeFactory } from "@achq/core";
import { flock } from "@achq/utils/flock";
import { subprocess } from "@achq/utils/subprocess";
import { savedAgentEnv } from "./agent-env.ts";
import type { LoadedConfig } from "./config/loader.ts";
import { ORPHAN_CHECK_INTERVAL_MS } from "./constants.ts";
import { withoutPrivate } from "./env.ts";
import { keepAwake, stayAwake } from "./keep-awake.ts";
import { threadBusy } from "./messages.ts";
import type { Paths } from "./paths.ts";
import { containerContext } from "./runtime-context.ts";
import { defaultRuntimes } from "./runtimes.ts";
import { sessionsFor } from "./sessions.ts";
import type { Vars } from "@achq/utils/env";

export type ResumeOptions = {
  paths: Paths;
  number: string;
  session: string;
  loadConfig: (commit: string) => Promise<LoadedConfig>;
  container: string;
  runtimes?: Record<string, RuntimeFactory>;
  env?: Vars;
  /** Defaults to inheriting the terminal. */
  stdio?: ["inherit" | "ignore", "inherit" | "ignore", "inherit" | "ignore"];
  out?: (text: string) => void;
};

type Session = ReturnType<typeof sessionsFor>[number];
type ResumeCommand = ReturnType<AgentRuntime["resumeCommand"]>;
type Stdio = NonNullable<ResumeOptions["stdio"]>;

const INHERIT: Stdio = ["inherit", "inherit", "inherit"];
const FORWARDED_SIGNALS = ["SIGHUP", "SIGTERM"] as const;

/**
 * Opens a thread's session interactively in its worktree, holding the
 * thread's lock so the agent's next run waits until you exit. Fails if a run
 * is in progress. Returns the exit status. Run over SSH by the laptop CLI,
 * which picks the session.
 */
export const resume = async (opts: ResumeOptions): Promise<number> => {
  const out = opts.out ?? ((text) => console.error(text));
  const session = sessionsFor(opts.paths, opts.number).find((s) => s.id === opts.session);
  if (!session) {
    out(`No session ${opts.session} on thread ${opts.number}`);
    return 1;
  }
  const command = await resumeCommandFor(opts, session);
  const threadKey = keyOf(session.state.thread);
  const env = opts.env ?? process.env;
  const code = await runAttached(flock.lockedArgv(opts.paths.lock(session.workspace, threadKey), command.argv), {
    cwd: opts.paths.worktree(session.workspace, threadKey),
    env: { ...withoutPrivate(env), HOME: opts.paths.home, ...savedAgentEnv(opts.paths.agentEnv), ...command.env },
    stdio: opts.stdio ?? INHERIT,
    keepAwake: keepAwake(env),
  });
  if (code === flock.BUSY) out(threadBusy(session.workspace));
  return code;
};

const resumeCommandFor = async (opts: ResumeOptions, session: Session): Promise<ResumeCommand> => {
  const config = await opts.loadConfig(session.commit);
  const agent = config.agents.find((a) => a.name === session.agent);
  const factory = agent && (opts.runtimes ?? defaultRuntimes)[agent.runtime];
  if (!agent || !factory) throw new Error(`Agent ${session.agent} isn't in the config at ${session.commit}`);
  const container = config.manifest.containers.find((c) => c.name === opts.container);
  const runtime = factory(agent, containerContext(config, opts.paths.home, opts.env ?? process.env, container));
  const configDir = opts.paths.agent(agent.name);
  await runtime.configure(configDir);
  return runtime.resumeCommand(session.id, configDir);
};

/**
 * Runs `argv` on the terminal until it exits. A dropped SSH connection doesn't
 * always reach the agent, which would then hold the lock forever, so it's
 * stopped when our parent (the SSH shell) goes away. An idle session makes no
 * outbound traffic, so `keepAwake` pings meanwhile.
 */
const runAttached = async (
  argv: string[],
  { cwd, env, stdio, keepAwake: ping }: { cwd: string; env: Record<string, string>; stdio: Stdio; keepAwake?: () => Promise<unknown> },
): Promise<number> => {
  const proc = Bun.spawn(argv, { cwd, env, stdio });
  const stops = [
    subprocess.killWhenOrphaned(proc, { intervalMs: ORPHAN_CHECK_INTERVAL_MS, signal: "SIGHUP" }),
    ping ? stayAwake(() => void ping().catch(() => {})) : () => {},
    subprocess.forwardSignals(proc, FORWARDED_SIGNALS),
  ];
  try {
    return await proc.exited;
  } finally {
    for (const stop of stops) stop();
  }
};
