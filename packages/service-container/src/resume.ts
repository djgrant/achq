import { type RuntimeFactory, threadKey as keyOf } from "@achq/core";
import type { Vars } from "@achq/utils/env";
import { flock } from "@achq/utils/flock";
import { subprocess } from "@achq/utils/subprocess";
import { savedAgentEnv, withoutPrivate } from "./agent-env.ts";
import type { LoadedConfig } from "./config.ts";
import { threadBusy } from "./messages.ts";
import { keepAwake, stayAwake } from "./runner.ts";
import { containerContext, defaultRuntimes } from "./runtime-context.ts";
import { type Paths, sessionsFor } from "./volume.ts";

/** How often `resume` checks whether the SSH shell that started it has gone. */
const ORPHAN_CHECK_INTERVAL_MS = 1000;
const FORWARDED_SIGNALS = ["SIGHUP", "SIGTERM"] as const;

type Stdio = ["inherit" | "ignore", "inherit" | "ignore", "inherit" | "ignore"];

export type ResumeOptions = {
  paths: Paths;
  number: string;
  session: string;
  loadConfig: (commit: string) => Promise<LoadedConfig>;
  container: string;
  runtimes?: Record<string, RuntimeFactory>;
  env?: Vars;
  /** Defaults to inheriting the terminal. */
  stdio?: Stdio;
  out?: (text: string) => void;
};

/**
 * Opens a thread's session interactively in its worktree, holding the
 * thread's lock so the agent's next run waits until you exit. Fails if a run
 * is in progress. Returns the exit status. Run over SSH by the laptop CLI,
 * which picks the session.
 */
export const resume = async (opts: ResumeOptions) => {
  const out = opts.out ?? ((text) => console.error(text));
  const session = sessionsFor(opts.paths, opts.number).find((s) => s.id === opts.session);
  if (!session) {
    out(`No session ${opts.session} on thread ${opts.number}`);
    return 1;
  }
  const env = opts.env ?? process.env;
  const config = await opts.loadConfig(session.commit);
  const agent = config.agents.find((a) => a.name === session.agent);
  const factory = agent && (opts.runtimes ?? defaultRuntimes)[agent.runtime];
  if (!agent || !factory) throw new Error(`Agent ${session.agent} isn't in the config at ${session.commit}`);
  const container = config.manifest.containers.find((c) => c.name === opts.container);
  const runtime = factory(agent, containerContext(config, opts.paths.home, env, container));
  const configDir = opts.paths.agent(agent.name);
  await runtime.configure(configDir);
  const command = runtime.resumeCommand(session.id, configDir);

  // A dropped SSH connection doesn't always reach the agent, which would then
  // hold the lock forever, so it's stopped when our parent (the SSH shell) goes
  // away. An idle session makes no outbound traffic, so it pings meanwhile.
  const threadKey = keyOf(session.state.thread);
  const proc = Bun.spawn(flock.lockedArgv(opts.paths.lock(session.workspace, threadKey), command.argv), {
    cwd: opts.paths.worktree(session.workspace, threadKey),
    env: { ...withoutPrivate(env), HOME: opts.paths.home, ...savedAgentEnv(opts.paths.agentEnv), ...command.env },
    stdio: opts.stdio ?? ["inherit", "inherit", "inherit"],
  });
  const ping = keepAwake(env);
  const stops = [
    subprocess.killWhenOrphaned(proc, { intervalMs: ORPHAN_CHECK_INTERVAL_MS, signal: "SIGHUP" }),
    ping ? stayAwake(() => void ping().catch(() => {})) : () => {},
    subprocess.forwardSignals(proc, FORWARDED_SIGNALS),
  ];
  const code = await proc.exited.finally(() => {
    for (const stop of stops) stop();
  });
  if (code === flock.BUSY) out(threadBusy(session.workspace));
  return code;
};
