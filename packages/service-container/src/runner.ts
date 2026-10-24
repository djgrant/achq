import { randomUUID } from "node:crypto";
import { type ChannelClient, type ChannelEvent, type ChannelProvider, type ClaimRequest, ENV, type PolicyProvider, type RepoManifest, type RuntimeContext, type RuntimeFactory, type Thread, type ThreadRef, threadKey } from "@achq/core";
import { ContainerEnvelope } from "@achq/core/protocol";
import { routerForContainer } from "@achq/core/client";
import { signedBy } from "@achq/core/signing";
import { async } from "@achq/utils/async";
import { disk } from "@achq/utils/disk";
import type { Vars } from "@achq/utils/env";
import { errors } from "@achq/utils/errors";
import { flock } from "@achq/utils/flock";
import { http } from "@achq/utils/http";
import { zValidator } from "@hono/zod-validator";
import { agentEnv, saveAgentEnv } from "./agent-env.ts";
import type { LoadedConfig } from "./config.ts";
import { MINUTE_MS } from "./constants.ts";
import { Credentials } from "./credentials.ts";
import { configLoadFailed, failureReply, NOTHING_TO_COMPACT, runFailed, runInterrupted, unrunnableAgent, worktreeFailed } from "./messages.ts";
import { buildPrompt, type Command, parseCommand } from "./prompt.ts";
import { describeHead, ensureWorktree, fetchMirror, fillBranch } from "./repo.ts";
import { containerContext, defaultRuntimes, writeFiles } from "./runtime-context.ts";
import { allStates, firstDelivery, paths as layout, type Paths, readState, type ThreadState, writeState } from "./volume.ts";

const KEEP_AWAKE_INTERVAL_MS = 3 * MINUTE_MS;

export type RunnerOptions = {
  repo: string;
  container: string;
  channelProviders: ChannelProvider[];
  policyProviders: PolicyProvider[];
  routerUrl: string;
  containerSecret: string;
  dataDir: string;
  repoUrl: string;
  loadConfig: (commit: string) => Promise<LoadedConfig>;
  runtimes?: Record<string, RuntimeFactory>;
  /** Runs going at once; more wait for one to finish. */
  maxRuns: number;
  runTimeoutMs: number;
  /** Private variables are removed. */
  env?: Vars;
  now?: () => number;
  /** Outbound traffic while runs are going, so the container provider doesn't sleep the container. Defaults to fetching ENV.keepAwakeUrl, when it's set. */
  keepAwake?: () => Promise<unknown>;
  log?: (line: string) => void;
};

type Workspace = RepoManifest["workspaces"][number];
type Trigger = RepoManifest["triggers"][number];

type TriggerRun = {
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

/** Outbound traffic, so the container provider doesn't sleep the container. Undefined on providers that don't need it. */
export const keepAwake = (env: Vars) => {
  const url = env[ENV.keepAwakeUrl];
  return url ? () => fetch(url) : undefined;
};

export const stayAwake = (tick: () => void) => async.every(KEEP_AWAKE_INTERVAL_MS, tick);

/** Waits for `work`, logging `<label>: <error>` instead of throwing: for side jobs whose failure nobody else can act on. */
const logFailure = async (work: Promise<unknown>, log: (line: string) => void, label: string) => {
  await work.then(
    () => {},
    (e) => log(`${label}: ${errors.message(e)}`),
  );
};

/** A reply that fails is logged, not thrown: there's nowhere else to report it. */
const reply = (client: ChannelClient, ref: ThreadRef, body: string, log: (line: string) => void) => logFailure(client.reply(ref, body), log, "reply failed");

/** At most `max` runs at once, across all threads. `onBusy` and `onIdle` mark the first run starting and the last one ending. */
class RunSlots {
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(
    private max: number,
    private hooks: { onBusy: () => void; onIdle: () => void },
  ) {}

  async run(fn: () => Promise<void>) {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    if (this.active++ === 0) this.hooks.onBusy();
    try {
      await fn();
    } finally {
      if (--this.active === 0) this.hooks.onIdle();
      this.waiting.shift()?.();
    }
  }
}

export class Runner {
  readonly paths: Paths;
  readonly credentials: Credentials;
  private router: ReturnType<typeof routerForContainer>;
  readonly fetch: (req: Request) => Response | Promise<Response>;
  /** One thread's runs go one after another. */
  private enqueue = async.keyedQueue();
  private pending = new Set<Promise<unknown>>();
  private slots: RunSlots;
  private runtimes: Record<string, RuntimeFactory>;
  private runTimeoutMs: number;
  private now: () => number;
  private log: (line: string) => void;

  constructor(private opts: RunnerOptions) {
    this.paths = layout(opts.dataDir);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => console.log(line));
    this.runtimes = opts.runtimes ?? defaultRuntimes;
    this.runTimeoutMs = opts.runTimeoutMs;
    this.router = routerForContainer({ url: opts.routerUrl, secret: opts.containerSecret });
    this.credentials = new Credentials({
      routerUrl: opts.routerUrl,
      containerSecret: opts.containerSecret,
      repo: opts.repo,
      container: opts.container,
      policyProviders: opts.policyProviders,
      paths: this.paths,
      now: this.now,
      log: this.log,
    });
    this.fetch = http
      .service(this.log)
      .post("/events", signedBy(opts.containerSecret, this.now), zValidator("json", ContainerEnvelope), (c) => {
        // Handled after answering: the router waits for the response.
        const envelope = c.req.valid("json");
        this.track(this.handle(envelope).catch((e) => this.log(`[${envelope.event.delivery}] ${errors.detail(e)}`)));
        return c.text("accepted", 202);
      }).fetch;

    // While any run is going, the container is kept awake: a long tool call can go
    // minutes without outbound traffic. Each tick also refreshes credentials near
    // expiry, and `install` rewrites them in place for the running agents.
    const ping = opts.keepAwake ?? keepAwake(this.baseEnv);
    let stopTicking = () => {};
    this.slots = new RunSlots(opts.maxRuns, {
      onBusy: () => {
        stopTicking = stayAwake(() => {
          void logFailure(this.credentials.get(), this.log, "credentials");
          ping?.().catch(() => {});
        });
      },
      onIdle: () => stopTicking(),
    });
    for (const dir of [this.paths.home, this.paths.threads, this.paths.deliveries]) disk.ensureDir(dir);
  }

  /** Resolves when everything in flight has finished. For tests and shutdown. */
  async idle() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private track(p: Promise<unknown>) {
    this.pending.add(p);
    p.finally(() => this.pending.delete(p));
  }

  private get baseEnv() {
    return this.opts.env ?? process.env;
  }

  async handle({ event, commit }: ContainerEnvelope) {
    const tag = `[${event.delivery}]`;
    if (!firstDelivery(this.paths.deliveries, event.delivery)) return this.log(`${tag} already handled`);
    const channel = this.opts.channelProviders.find((c) => c.id === event.channel);
    const ref = event.thread;
    if (!channel || !ref) return;
    // Only trusted people start runs.
    if (!event.actor?.trusted || event.actor.bot) return this.log(`${tag} ignored: actor isn't a trusted person`);

    const config = await this.opts.loadConfig(commit).catch(async (e) => {
      // The router only forwards events some trigger matches, so someone is waiting on a reply.
      const message = errors.message(e);
      this.log(`${tag} couldn't load the config at ${commit}: ${message}`);
      await reply(await this.client(channel, event.source), ref, configLoadFailed(commit, message), this.log);
    });
    if (!config) return;
    const workspaces = config.manifest.workspaces.filter((w) => w.container === this.opts.container && w.threads.channel === channel.id);
    const triggers = config.manifest.triggers.filter((t) => t.event.channel === channel.id && channel.matchEvent(t.event, event));
    if (!workspaces.length || !triggers.length) return this.log(`${tag} no trigger here matches ${event.type}`);

    const key = threadKey(ref);
    const queued = this.enqueue(key, () => this.slots.run(() => this.work(event, ref, config, channel, workspaces, triggers)));
    this.track(queued.catch((e) => this.log(`[${key}] ${errors.detail(e)}`)));
  }

  private async client(channel: ChannelProvider, source: string) {
    return channel.client(await this.credentials.channel(channel.id, source));
  }

  /** Claims the thread, then runs each matched trigger in its worktree, holding the thread's lock. */
  private async work(event: ChannelEvent, ref: ThreadRef, config: LoadedConfig, channel: ChannelProvider, workspaces: Workspace[], triggers: Trigger[]) {
    const key = threadKey(ref);
    const log = (line: string) => this.log(`[${key}] ${line}`);
    const client = await this.client(channel, event.source);
    const thread = await client.thread(ref);

    // The workspace that claimed the thread, or the first of this container's that matches it now.
    const file = this.paths.thread(key);
    const claimed = readState(file);
    let state: ThreadState;
    if (claimed && workspaces.some((w) => w.name === claimed.workspace)) state = claimed;
    else {
      const claiming = workspaces.find((w) => channel.matchThread(w.threads, { ref, labels: thread.labels }));
      if (!claiming) return log("no workspace in this container claims it");
      state = { thread: ref, source: event.source, number: thread.vars.number, workspace: claiming.name, sessions: {} };
      writeState(file, state);
      // Recorded on the router, so it sends the thread's events here.
      const claim: ClaimRequest = { repo: this.opts.repo, container: this.opts.container, workspace: claiming.name, thread: ref };
      void logFailure(this.router.claim(claim), this.log, "claim not recorded");
    }
    const workspace = workspaces.find((w) => w.name === state.workspace)!;

    await logFailure(client.acknowledge(event), log, "acknowledge failed");
    await flock.withLock(this.paths.lock(workspace.name, key), async () => {
      const { env: credentialEnv } = await this.credentials.get();
      const cwd = this.paths.worktree(workspace.name, key);
      try {
        const gitEnv = { ...process.env, ...credentialEnv };
        await fetchMirror(this.paths.mirror, this.opts.repoUrl, gitEnv);
        await ensureWorktree(this.paths.mirror, cwd, fillBranch(workspace.branch, thread.vars), workspace.base, gitEnv);
      } catch (e) {
        return reply(client, ref, worktreeFailed(errors.message(e)), log);
      }
      const ctx = await this.contextFor(config);
      // Saved for `resume`, which opens sessions outside the runner.
      const env = agentEnv(this.baseEnv, this.paths.home, credentialEnv, await client.identity());
      saveAgentEnv(this.paths.agentEnv, credentialEnv, env);
      for (const trigger of triggers) await this.runTrigger({ trigger, event, config, ctx, client, thread, state, cwd, env, log });
    });
  }

  private async runTrigger({ trigger, event, config, ctx, client, thread, state, cwd, env, log }: TriggerRun) {
    const agent = config.agents.find((a) => a.name === trigger.agent);
    const factory = agent && this.runtimes[agent.runtime];
    if (!agent || !factory) return reply(client, thread.ref, unrunnableAgent(trigger), log);
    const mention = typeof trigger.event.mention === "string" ? trigger.event.mention : undefined;
    // A run not started by a mention has nothing to say.
    const command: Command = mention && event.text ? parseCommand(event.text, mention) : { mode: "resume", text: "" };
    const agentLog = (line: string) => log(`${agent.name}: ${line}`);
    const saveState = () => writeState(this.paths.thread(threadKey(thread.ref)), state);
    const finishSession = () => {
      const session = state.sessions[agent.name];
      if (session?.status !== "running") return;
      session.status = "idle";
      saveState();
    };

    try {
      const runtime = factory(agent, ctx);
      const key = await runtime.sessionKey();
      // `/new`, no session yet, or a changed session key start afresh. Compacting needs a session to compact.
      const previous = state.sessions[agent.name];
      const fresh = command.mode === "new" || !previous || previous.key !== key;
      if (command.mode === "compact" && fresh) throw new Error(NOTHING_TO_COMPACT);
      const id = fresh ? randomUUID() : previous!.id;

      let prompt: { prompt: string; lastMessage?: string; opening?: string };
      if (command.mode === "compact") prompt = { prompt: `/compact ${command.text}`.trim(), lastMessage: previous?.lastMessage, opening: previous?.opening };
      else {
        const built = buildPrompt({
          mode: fresh ? "new" : "resume",
          thread,
          messages: await client.messages(thread.ref),
          since: previous?.lastMessage,
          opening: previous?.opening,
          mention,
          ...(event.previousText !== undefined && event.message && { edited: event.message }),
          by: event.actor!.login,
          ...(await describeHead(cwd)),
        });
        // An earlier run already picked this up along with other messages.
        if (!fresh && built.included === 0) return agentLog("nothing new since the last run; skipping");
        prompt = built;
      }

      // Marked running first, so a restart mid-run can say so.
      state.sessions[agent.name] = { key, id, lastMessage: prompt.lastMessage, opening: prompt.opening, status: "running", lastRun: new Date(this.now()).toISOString(), commit: config.commit };
      saveState();
      agentLog(`${fresh ? "new" : "resumed"} session ${id} (trigger ${trigger.name})`);
      const configDir = this.paths.agent(agent.name);
      await runtime.configure(configDir);
      const result = await runtime.run({
        thread: thread.ref,
        cwd,
        configDir,
        env,
        prompt: prompt.prompt,
        session: fresh ? { new: id } : { resume: id },
        signal: AbortSignal.timeout(this.runTimeoutMs),
        log: agentLog,
      });
      finishSession();
      await reply(client, thread.ref, result.error ? runFailed(result.error, mention) : result.reply, log);
    } catch (e) {
      agentLog(errors.detail(e));
      finishSession();
      await reply(client, thread.ref, failureReply(errors.message(e)), log);
    }
  }

  /** Session keys and runtimes read the container's startup files, so they're written here, once per config. */
  private contextFor = async.memo(async (config: LoadedConfig) => {
    const container = config.manifest.containers.find((c) => c.name === this.opts.container);
    if (!container) throw new Error(`The config at ${config.commit} has no container "${this.opts.container}"`);
    const ctx = containerContext(config, this.paths.home, this.baseEnv, container);
    writeFiles(ctx.containerFiles, this.paths.home);
    return ctx;
  });

  async reportInterrupted() {
    for (const { file, state } of allStates(this.paths.threads)) {
      const interrupted = Object.entries(state.sessions).filter(([, s]) => s.status === "running");
      if (!interrupted.length) continue;
      for (const [, s] of interrupted) s.status = "interrupted";
      writeState(file, state);
      const channel = this.opts.channelProviders.find((c) => c.id === state.thread.channel);
      if (!channel) continue;
      const sessions = interrupted.map(([agent, s]) => `${agent} \`${s.id}\``).join(", ");
      const told = this.client(channel, state.source).then((client) => client.reply(state.thread, runInterrupted(sessions)));
      await logFailure(told, this.log, `[${threadKey(state.thread)}] couldn't report the interrupted run`);
    }
  }
}
