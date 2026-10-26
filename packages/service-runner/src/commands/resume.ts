import { type RuntimeFactory, threadKey as keyOf } from "@achq/core";
import type { Vars } from "@achq/utils/env";
import { flock } from "@achq/utils/flock";
import { subprocess } from "@achq/utils/subprocess";
import { savedAgentEnv, withoutPrivate } from "../features/agent-env.ts";
import { type ConfigModules, createConfigLoader, type LoadedConfig } from "../features/config.ts";
import type { Paths } from "../features/layout.ts";
import { threadBusy } from "../features/messages.ts";
import { fetchMirror } from "../features/repo.ts";
import { keepAwake, stayAwake } from "../features/runner.ts";
import { containerContext } from "../features/runtime-context.ts";
import { sessionsFor } from "../state.ts";

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
  /** The agent runtimes the container loaded, by id. */
  runtimes: Record<string, RuntimeFactory>;
  /** What's never given to an agent. */
  privateEnv: string[];
  env?: Vars;
  /** Defaults to inheriting the terminal. */
  stdio?: Stdio;
  out?: (text: string) => void;
};

/** Offline when the commit's already in the mirror; otherwise fetches with the last run's credentials. `modules` are what the config may import. */
export const resumeConfig = (paths: Paths, repoUrl: string, modules: ConfigModules) =>
  createConfigLoader({
    modules,
    mirror: paths.mirror,
    dir: (commit) => `${paths.config(commit)}-resume`,
    fetch: () => fetchMirror(paths.mirror, repoUrl, { ...process.env, ...savedAgentEnv(paths.agentEnv) }),
  });

/**
 * `resume <thread> <session>`: opens a thread's session interactively in its worktree, holding the
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
  const factory = agent && opts.runtimes[agent.runtime];
  if (!agent || !factory) throw new Error(`Agent ${session.agent} isn't in the config at ${session.commit}`);
  const container = config.manifest.containers.find((c) => c.name === opts.container);
  const runtime = factory(agent, containerContext(config, opts.paths.home, env, opts.privateEnv, container));
  const configDir = opts.paths.agent(agent.name);
  await runtime.configure(configDir);
  const command = runtime.resumeCommand(session.id, configDir);

  // A dropped SSH connection doesn't always reach the agent, which would then
  // hold the lock forever, so it's stopped when our parent (the SSH shell) goes
  // away. An idle session makes no outbound traffic, so it pings meanwhile.
  const threadKey = keyOf(session.state.thread);
  const proc = Bun.spawn(flock.lockedArgv(opts.paths.lock(session.workspace, threadKey), command.argv), {
    cwd: opts.paths.worktree(session.workspace, threadKey),
    env: { ...withoutPrivate(env, opts.privateEnv), HOME: opts.paths.home, ...savedAgentEnv(opts.paths.agentEnv), ...command.env },
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
