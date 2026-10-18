// `achq-agent sessions <n>` and `achq-agent resume <n> [session]`, run over SSH
// by the laptop CLI, which does any picking.
import * as fs from "node:fs";
import * as path from "node:path";
import { threadKey as keyOf, type RuntimeFactory } from "@achq/core";
import type { LoadedConfig } from "./config.ts";
import { withoutPrivate } from "./env.ts";
import { BUSY, lockedArgv } from "@achq/flock";
import type { Paths } from "./paths.ts";
import { defaultRuntimes, runtimeContext } from "./runtimes.ts";
import { allStates, type ThreadState } from "./state.ts";
import { PROMPTS } from "./prompt.ts";
import { resolveFiles } from "./files.ts";

export type SessionInfo = { id: string; agent: string; workspace: string; lastRun: string };

const threadNumber = (state: ThreadState) => state.number ?? state.thread.id.match(/#(\w+)$/)?.[1];

/** A thread's sessions, most recently run first. */
export const sessionsFor = (paths: Paths, number: string): (SessionInfo & { state: ThreadState; commit: string })[] =>
  allStates(paths.threads)
    .filter(({ state }) => threadNumber(state) === number)
    .flatMap(({ state }) =>
      Object.entries(state.sessions).map(([agent, s]) => ({ id: s.id, agent, workspace: state.workspace, lastRun: s.lastRun, state, commit: s.commit })),
    )
    .sort((a, b) => b.lastRun.localeCompare(a.lastRun));

/** A JSON array, which the laptop's `achq resume` reads over SSH (see cli/lib/remote.ts parseSessions). */
export const formatSessions = (sessions: SessionInfo[]) =>
  JSON.stringify(sessions.map(({ id, agent, workspace, lastRun }) => ({ id, agent, workspace, lastRun })));

/**
 * Which session `resume` opens: the one named (by ID, or by agent if that's
 * unambiguous), or the only one. Otherwise there's nothing to pick from here.
 */
export const pickSession = <T extends SessionInfo>(sessions: T[], wanted?: string): { session: T } | { error: string } => {
  if (!sessions.length) return { error: "This thread has no sessions." };
  if (wanted) {
    const byId = sessions.filter((s) => s.id === wanted);
    const matches = byId.length ? byId : sessions.filter((s) => s.agent === wanted);
    if (matches.length === 1) return { session: matches[0]! };
    return { error: matches.length ? `Several sessions match "${wanted}":` : `No session matches "${wanted}". This thread's sessions:` };
  }
  if (sessions.length === 1) return { session: sessions[0]! };
  return { error: "This thread has several sessions; name one:" };
};

export type ResumeOptions = {
  paths: Paths;
  number: string;
  session?: string;
  loadConfig: (commit: string) => Promise<LoadedConfig>;
  container: string;
  bin?: Record<string, string>;
  runtimes?: Record<string, RuntimeFactory>;
  env?: Record<string, string | undefined>;
  /** Defaults to inheriting the terminal. */
  stdio?: ["inherit" | "ignore", "inherit" | "ignore", "inherit" | "ignore"];
  out?: (text: string) => void;
};

/**
 * Opens a thread's session interactively in its worktree, holding the
 * thread's lock so the agent's next run waits until you exit. Fails if a run
 * is in progress. Returns the exit status.
 */
export const resume = async (opts: ResumeOptions): Promise<number> => {
  const out = opts.out ?? ((text) => console.error(text));
  const sessions = sessionsFor(opts.paths, opts.number);
  const picked = pickSession(sessions, opts.session);
  if ("error" in picked) {
    out(picked.error);
    if (sessions.length) out(formatSessions(sessions));
    return 1;
  }
  const { session } = picked;
  const config = await opts.loadConfig(session.commit);
  const agent = config.agents.find((a) => a.name === session.agent);
  const factory = agent && (opts.runtimes ?? defaultRuntimes)[agent.agentKind];
  if (!agent || !factory) throw new Error(`Agent ${session.agent} isn't in the config at ${session.commit}`);
  const container = config.plan.containers.find((c) => c.name === opts.container);
  const runtime = factory(agent, runtimeContext(config.root, {
    home: opts.paths.home,
    runnerPrompt: fs.readFileSync(path.join(PROMPTS, "system.md"), "utf8"),
    containerFiles: resolveFiles(container?.files, config.root),
    bin: opts.bin ?? {},
  }));
  const configDir = opts.paths.agent(agent.name);
  await runtime.configure(configDir);
  const command = runtime.resumeCommand(session.id, configDir);
  const saved = fs.existsSync(opts.paths.agentEnv) ? JSON.parse(fs.readFileSync(opts.paths.agentEnv, "utf8")) : {};
  const threadKey = keyOf(session.state.thread);

  const proc = Bun.spawn(lockedArgv(opts.paths.lock(session.workspace, threadKey), command.argv), {
    cwd: opts.paths.worktree(session.workspace, threadKey),
    env: { ...withoutPrivate(opts.env ?? process.env), HOME: opts.paths.home, ...saved, ...command.env },
    stdio: opts.stdio ?? ["inherit", "inherit", "inherit"],
  });
  // A dropped SSH connection doesn't always reach the agent, which would then
  // hold the lock forever. Stop it when our parent (the SSH shell) goes away.
  const parent = process.ppid;
  const orphaned = setInterval(() => process.ppid !== parent && proc.kill("SIGHUP"), 1000);
  // Railway sleeps the service after minutes without outbound traffic, which an idle session doesn't make.
  const awake = setInterval(() => fetch("https://api.github.com/zen").catch(() => {}), 3 * 60_000);
  const forward = (signal: NodeJS.Signals) => () => proc.kill(signal);
  const handlers = (["SIGHUP", "SIGTERM"] as const).map((signal) => [signal, forward(signal)] as const);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const code = await proc.exited;
  clearInterval(orphaned);
  clearInterval(awake);
  for (const [signal, handler] of handlers) process.off(signal, handler);
  if (code === BUSY) {
    out(`An agent is working on this thread in ${session.workspace}. Try again when its run finishes.`);
    return BUSY;
  }
  return code;
};
