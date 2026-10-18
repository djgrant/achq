import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type ClaimRequest, type EventEnvelope, type RepoPlan, type AccessProvider, type Channel, type ChannelClient, type ChannelEvent, type Thread, threadKey, type RuntimeContext, type RuntimeFactory } from "@achq/core";
import { signedFetch, verifySigned } from "@achq/core/signing";
import { parseCommand, type Command } from "./command.ts";
import type { LoadedConfig } from "./config.ts";
import { Credentials } from "./credentials.ts";
import { withoutPrivate } from "./env.ts";
import { resolveFiles, writeFiles } from "./files.ts";
import { acquire } from "@achq/flock";
import { paths as layout, type Paths } from "./paths.ts";
import { buildPrompt, PROMPTS } from "./prompt.ts";
import { describeHead, ensureWorktree, fetchMirror, fillBranch } from "./repo.ts";
import { defaultRuntimes, runtimeContext } from "./runtimes.ts";
import { allStates, readState, type ThreadState, writeState } from "./state.ts";

export type RunnerOptions = {
  /** `owner/name`. */
  repo: string;
  /** This container's name in the repo's config. */
  container: string;
  channels: Channel[];
  providers: AccessProvider[];
  routerUrl: string;
  containerSecret: string;
  dataDir: string;
  /** The mirror's remote. */
  repoUrl: string;
  loadConfig: (commit: string | undefined) => Promise<LoadedConfig>;
  bin?: Record<string, string>;
  runtimes?: Record<string, RuntimeFactory>;
  /** How many runs may go at once, across all threads. */
  maxRuns?: number;
  runTimeoutMs?: number;
  /** The base env agents get, before credentials. Private variables are removed. */
  env?: Record<string, string | undefined>;
  now?: () => number;
  /** Outbound traffic while runs are going, so the host doesn't sleep the container. */
  keepAwake?: () => Promise<unknown>;
  log?: (line: string) => void;
};

type Workspace = RepoPlan["workspaces"][number];
type Trigger = RepoPlan["triggers"][number];

export class Runner {
  readonly paths: Paths;
  readonly credentials: Credentials;
  private queues = new Map<string, Promise<void>>();
  private pending = new Set<Promise<unknown>>();
  private active = 0;
  private waiting: (() => void)[] = [];
  private awake?: Timer;
  private now: () => number;
  private log: (line: string) => void;

  constructor(private opts: RunnerOptions) {
    this.paths = layout(opts.dataDir);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => console.log(line));
    this.credentials = new Credentials({
      routerUrl: opts.routerUrl,
      containerSecret: opts.containerSecret,
      repo: opts.repo,
      container: opts.container,
      providers: opts.providers,
      paths: this.paths,
      now: this.now,
      log: this.log,
    });
    for (const dir of [this.paths.home, this.paths.threads, this.paths.deliveries]) fs.mkdirSync(dir, { recursive: true });
  }

  /** The HTTP handler: `GET /` health, `POST /events` signed by the router. */
  fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/") return new Response("ok");
    if (req.method !== "POST" || url.pathname !== "/events") return new Response("not found", { status: 404 });
    const body = await req.text();
    if (!verifySigned(this.opts.containerSecret, "POST", "/events", body, req.headers, this.now())) {
      return new Response("bad signature", { status: 401 });
    }
    let envelope: EventEnvelope;
    try {
      envelope = JSON.parse(body);
      if (!envelope?.event?.delivery) throw new Error("no delivery");
    } catch {
      return new Response("bad request", { status: 400 });
    }
    this.track(this.handle(envelope).catch((e) => this.log(`[${envelope.event.delivery}] ${e instanceof Error ? e.stack : e}`)));
    return new Response("accepted", { status: 202 });
  };

  /** Resolves when everything in flight has finished. For tests and shutdown. */
  async idle() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private track(p: Promise<unknown>) {
    this.pending.add(p);
    p.finally(() => this.pending.delete(p));
  }

  /** Handles one event; resolves once its runs (if any) are queued. */
  async handle({ event, commit }: EventEnvelope): Promise<void> {
    if (!this.firstDelivery(event.delivery)) return this.log(`[${event.delivery}] already handled`);
    const channel = this.opts.channels.find((c) => c.id === event.channel);
    if (!channel || !event.thread) return;
    if (!event.actor?.trusted || event.actor.bot) return this.log(`[${event.delivery}] ignored: actor isn't a trusted person`);

    let config: LoadedConfig;
    try {
      config = await this.opts.loadConfig(commit);
    } catch (e) {
      // The router only forwards events some trigger matches, so someone is waiting on a reply.
      const message = e instanceof Error ? e.message : String(e);
      this.log(`[${event.delivery}] couldn't load the config at ${commit}: ${message}`);
      const client = await this.client(channel, event.source);
      return this.reply(client, event.thread, `⚠️ Couldn't load \`.achq/\` at ${commit?.slice(0, 7) ?? "the deployed commit"}: ${message}`, this.log);
    }
    const workspaces = config.plan.workspaces.filter((w) => w.container === this.opts.container && w.threads.channel === channel.id);
    const triggers = config.plan.triggers.filter((t) => t.event.channel === channel.id && channel.matchEvent(t.event, event));
    if (!workspaces.length || !triggers.length) return this.log(`[${event.delivery}] no trigger here matches ${event.type}`);

    const key = threadKey(event.thread);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => this.slot(() => this.work(event, config, workspaces, triggers)))
      .catch((e) => this.log(`[${key}] ${e instanceof Error ? e.stack : e}`));
    this.queues.set(key, next);
    this.track(next);
  }

  /** Records the delivery; false if it was already handled. Persisted, so it holds across restarts. */
  private firstDelivery(delivery: string) {
    try {
      fs.writeFileSync(path.join(this.paths.deliveries, delivery.replace(/[^A-Za-z0-9._-]/g, "_")), "", { flag: "wx" });
      return true;
    } catch (e: any) {
      if (e.code === "EEXIST") return false;
      throw e;
    }
  }

  private async slot(fn: () => Promise<void>) {
    if (this.active >= (this.opts.maxRuns ?? 2)) await new Promise<void>((resolve) => this.waiting.push(resolve));
    if (this.active++ === 0) this.stayAwake();
    try {
      await fn();
    } finally {
      if (--this.active === 0) clearInterval(this.awake);
      this.waiting.shift()?.();
    }
  }

  /**
   * Railway sleeps a service after minutes without outbound traffic, and a
   * long tool call can go that long. Each tick also refreshes credentials near
   * expiry, and `install` rewrites them in place for the running agents.
   */
  private stayAwake() {
    this.awake = setInterval(() => {
      this.credentials.get().catch((e) => this.log(`credentials: ${e}`));
      (this.opts.keepAwake ?? (() => fetch("https://api.github.com/zen")))().catch(() => {});
    }, 3 * 60_000);
  }

  private async client(channel: Channel, source: string) {
    return channel.client(await this.credentials.channel(channel.id, source));
  }

  /** The workspace that claimed the thread, or the first of this container's that matches it now. */
  private async claim(channel: Channel, event: ChannelEvent, thread: Thread, workspaces: Workspace[]): Promise<ThreadState | undefined> {
    const file = this.paths.thread(threadKey(thread.ref));
    const existing = readState(file);
    if (existing && workspaces.some((w) => w.name === existing.workspace)) return existing;
    const workspace = workspaces.find((w) => channel.matchThread(w.threads, { ref: thread.ref, labels: thread.labels }));
    if (!workspace) return undefined;
    const state: ThreadState = { thread: thread.ref, source: event.source, number: thread.vars.number, workspace: workspace.name, sessions: {} };
    writeState(file, state);
    const claim: ClaimRequest = { repo: this.opts.repo, container: this.opts.container, workspace: workspace.name, thread: thread.ref };
    signedFetch(this.opts.containerSecret, `${this.opts.routerUrl}/claims`, { method: "POST", body: JSON.stringify(claim) })
      .then((res) => res.ok || this.log(`claim not recorded: ${res.status}`))
      .catch((e) => this.log(`claim not recorded: ${e}`));
    return state;
  }

  private async work(event: ChannelEvent, config: LoadedConfig, workspaces: Workspace[], triggers: Trigger[]) {
    const ref = event.thread!;
    const key = threadKey(ref);
    const log = (line: string) => this.log(`[${key}] ${line}`);
    const channel = this.opts.channels.find((c) => c.id === event.channel)!;
    const client = await this.client(channel, event.source);
    const thread = await client.thread(ref);
    const claimed = await this.claim(channel, event, thread, workspaces);
    if (!claimed) return log("no workspace in this container claims it");
    const workspace = workspaces.find((w) => w.name === claimed.workspace)!;

    await client.acknowledge(event).catch((e) => log(`acknowledge failed: ${e}`));
    const release = await acquire(this.paths.lock(workspace.name, key));
    try {
      const { env: credentialEnv } = await this.credentials.get();
      const gitEnv = { ...process.env, ...credentialEnv };
      const cwd = this.paths.worktree(workspace.name, key);
      try {
        await fetchMirror(this.paths.mirror, this.opts.repoUrl, gitEnv);
        await ensureWorktree(this.paths.mirror, cwd, fillBranch(workspace.branch, thread.vars), workspace.base, gitEnv);
      } catch (e) {
        return await this.reply(client, ref, `⚠️ Couldn't set up the worktree: ${e instanceof Error ? e.message : e}`, log);
      }
      const ctx = this.contextFor(config);
      const identity = await client.identity();
      const env: Record<string, string> = {
        ...withoutPrivate(this.opts.env ?? process.env),
        HOME: this.paths.home,
        ...credentialEnv,
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email,
      };
      // For `resume`, which opens sessions outside the runner.
      const agentEnv = { ...credentialEnv, ...Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("GIT_AUTHOR_") || k.startsWith("GIT_COMMITTER_"))) };
      fs.mkdirSync(path.dirname(this.paths.agentEnv), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.paths.agentEnv, JSON.stringify(agentEnv), { mode: 0o600 });
      for (const trigger of triggers) {
        await this.runTrigger({ trigger, event, config, ctx, client, thread, state: claimed, cwd, env, log });
      }
    } finally {
      await release();
    }
  }

  /** Session keys and runtimes read the container's startup files, so they're written here, once per config. */
  private contexts = new Map<string, RuntimeContext>();
  private contextFor(config: LoadedConfig): RuntimeContext {
    let ctx = this.contexts.get(config.commit);
    if (!ctx) {
      const container = config.plan.containers.find((c) => c.name === this.opts.container);
      if (!container) throw new Error(`The config at ${config.commit} has no container "${this.opts.container}"`);
      const containerFiles = resolveFiles(container.files, config.root);
      writeFiles(containerFiles, this.paths.home);
      ctx = runtimeContext(config.root, {
        home: this.paths.home,
        runnerPrompt: fs.readFileSync(path.join(PROMPTS, "system.md"), "utf8"),
        containerFiles,
        bin: this.opts.bin ?? {},
      });
      this.contexts.set(config.commit, ctx);
    }
    return ctx;
  }

  private async runTrigger(r: {
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
  }) {
    const { trigger, event, config, client, thread, state, cwd, log } = r;
    const agent = config.agents.find((a) => a.name === trigger.agent);
    const factory = agent && (this.opts.runtimes ?? defaultRuntimes)[agent.agentKind];
    if (!agent || !factory) return this.reply(client, thread.ref, `⚠️ Trigger \`${trigger.name}\` names agent \`${trigger.agent}\`, which this container can't run.`, log);

    const mention = typeof trigger.event.mention === "string" ? trigger.event.mention : undefined;
    const command: Command = mention && event.text ? parseCommand(event.text, mention) : { mode: "resume", text: "" };
    const stateFile = this.paths.thread(threadKey(thread.ref));
    const configDir = this.paths.agent(agent.name);
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
      state.sessions[agent.name] = { key: sessionKey, id, lastMessage, opening, status: "running", lastRun: new Date(this.now()).toISOString(), commit: config.commit };
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
        signal: AbortSignal.timeout(this.opts.runTimeoutMs ?? 6 * 60 * 60_000),
        log: (line) => log(`${agent.name}: ${line}`),
      });
      state.sessions[agent.name]!.status = "idle";
      writeState(stateFile, state);
      const message = result.error
        ? `⚠️ **The run failed.**\n\n<details><summary>Error output</summary>\n\n\`\`\`\n${result.error}\n\`\`\`\n\n</details>${hint}`
        : result.reply;
      await this.reply(client, thread.ref, message, log);
    } catch (e) {
      log(`${agent.name}: ${e instanceof Error ? e.stack : e}`);
      const session = state.sessions[agent.name];
      if (session?.status === "running") {
        session.status = "idle";
        writeState(stateFile, state);
      }
      await this.reply(client, thread.ref, `⚠️ ${e instanceof Error ? e.message : String(e)}`, log);
    }
  }

  private async reply(client: ChannelClient, ref: Thread["ref"], body: string, log: (line: string) => void) {
    await client.reply(ref, body).catch((e) => log(`reply failed: ${e}`));
  }

  /** Marks runs a restart interrupted and says so on their threads. */
  async reportInterrupted() {
    for (const { file, state } of allStates(this.paths.threads)) {
      const interrupted = Object.entries(state.sessions).filter(([, s]) => s.status === "running");
      if (!interrupted.length) continue;
      for (const [, s] of interrupted) s.status = "interrupted";
      writeState(file, state);
      const channel = this.opts.channels.find((c) => c.id === state.thread.channel);
      if (!channel) continue;
      const list = interrupted.map(([agent, s]) => `${agent} \`${s.id}\``).join(", ");
      try {
        const client = await this.client(channel, state.source);
        await client.reply(
          state.thread,
          `⚠️ The agent restarted while a run was in progress. The work so far is in the worktree and the session is intact; the next message resumes it.\n\n<sub>${list}</sub>\n`,
        );
      } catch (e) {
        this.log(`[${threadKey(state.thread)}] couldn't report the interrupted run: ${e}`);
      }
    }
  }
}
