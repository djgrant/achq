import * as fs from "node:fs";
import { type Channel, type ChannelEvent, type ContainerEnvelope, type PolicyProvider, type RepoManifest, type RuntimeContext, type RuntimeFactory, threadKey } from "@achq/core";
import { acquire } from "@achq/utils/flock";
import { agentEnv, saveAgentEnv } from "./agent-env.ts";
import { claimThread } from "./claim.ts";
import type { LoadedConfig } from "./config/loader.ts";
import { DEFAULT_MAX_RUNS, DEFAULT_RUN_TIMEOUT_MINUTES } from "./constants.ts";
import { Credentials } from "./credentials.ts";
import { firstDelivery } from "./deliveries.ts";
import { eventsHandler } from "./events-handler.ts";
import { resolveFiles, writeFiles } from "./files.ts";
import { reportInterrupted } from "./interrupted.ts";
import { withoutPrivate } from "./env.ts";
import { keepAwake, stayAwake } from "./keep-awake.ts";
import { paths as layout, type Paths } from "./paths.ts";
import { fillBranch } from "./branch.ts";
import { reply } from "./reply.ts";
import { ensureWorktree, fetchMirror } from "./repo.ts";
import { runTrigger, type TriggerDeps } from "./run-trigger.ts";
import { runnerPrompt } from "./runner-prompt.ts";
import { runtimeContext } from "./runtime-context.ts";
import { defaultRuntimes } from "./runtimes.ts";
import { RunSlots } from "./slots.ts";

export type RunnerOptions = {
  /** `owner/name`. */
  repo: string;
  /** This container's name in the repo's config. */
  container: string;
  channels: Channel[];
  policyProviders: PolicyProvider[];
  routerUrl: string;
  containerSecret: string;
  dataDir: string;
  /** The mirror's remote. */
  repoUrl: string;
  loadConfig: (commit: string) => Promise<LoadedConfig>;
  runtimes?: Record<string, RuntimeFactory>;
  /** How many runs may go at once, across all threads. */
  maxRuns?: number;
  runTimeoutMs?: number;
  /** The base env agents get, before credentials. Private variables are removed. */
  env?: Record<string, string | undefined>;
  now?: () => number;
  /** Outbound traffic while runs are going, so the container host doesn't sleep the container. Defaults to fetching ENV.keepAwakeUrl, when it's set. */
  keepAwake?: () => Promise<unknown>;
  log?: (line: string) => void;
};

type Workspace = RepoManifest["workspaces"][number];
type Trigger = RepoManifest["triggers"][number];

export class Runner {
  readonly paths: Paths;
  readonly credentials: Credentials;
  /** The HTTP handler: `GET /` health, `POST /events` signed by the router. */
  readonly fetch: (req: Request) => Promise<Response>;
  private queues = new Map<string, Promise<void>>();
  private pending = new Set<Promise<unknown>>();
  private slots: RunSlots;
  private triggerDeps: TriggerDeps;
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
      policyProviders: opts.policyProviders,
      paths: this.paths,
      now: this.now,
      log: this.log,
    });
    this.fetch = eventsHandler({
      secret: opts.containerSecret,
      now: this.now,
      accept: (envelope) => this.track(this.handle(envelope).catch((e) => this.log(`[${envelope.event.delivery}] ${e instanceof Error ? e.stack : e}`))),
    });
    // A long tool call can go minutes without outbound traffic. Each tick also
    // refreshes credentials near expiry, and `install` rewrites them in place
    // for the running agents.
    let stop = () => {};
    const ping = opts.keepAwake ?? keepAwake(opts.env ?? process.env);
    this.slots = new RunSlots(opts.maxRuns ?? DEFAULT_MAX_RUNS, {
      onBusy: () => {
        stop = stayAwake(() => {
          this.credentials.get().catch((e) => this.log(`credentials: ${e}`));
          ping?.().catch(() => {});
        });
      },
      onIdle: () => stop(),
    });
    this.triggerDeps = {
      paths: this.paths,
      runtimes: opts.runtimes ?? defaultRuntimes,
      runTimeoutMs: opts.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MINUTES * 60_000,
      now: this.now,
    };
    for (const dir of [this.paths.home, this.paths.threads, this.paths.deliveries]) fs.mkdirSync(dir, { recursive: true });
  }

  /** Resolves when everything in flight has finished. For tests and shutdown. */
  async idle() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private track(p: Promise<unknown>) {
    this.pending.add(p);
    p.finally(() => this.pending.delete(p));
  }

  /** Handles one event; resolves once its runs (if any) are queued. */
  async handle({ event, commit }: ContainerEnvelope): Promise<void> {
    if (!firstDelivery(this.paths.deliveries, event.delivery)) return this.log(`[${event.delivery}] already handled`);
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
      return reply(client, event.thread, `⚠️ Couldn't load \`.achq/\` at ${commit.slice(0, 7)}: ${message}`, this.log);
    }
    const workspaces = config.manifest.workspaces.filter((w) => w.container === this.opts.container && w.threads.channel === channel.id);
    const triggers = config.manifest.triggers.filter((t) => t.event.channel === channel.id && channel.matchEvent(t.event, event));
    if (!workspaces.length || !triggers.length) return this.log(`[${event.delivery}] no trigger here matches ${event.type}`);

    const key = threadKey(event.thread);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => this.slots.run(() => this.work(event, config, workspaces, triggers)))
      .catch((e) => this.log(`[${key}] ${e instanceof Error ? e.stack : e}`));
    this.queues.set(key, next);
    this.track(next);
  }

  private async client(channel: Channel, source: string) {
    return channel.client(await this.credentials.channel(channel.id, source));
  }

  private async work(event: ChannelEvent, config: LoadedConfig, workspaces: Workspace[], triggers: Trigger[]) {
    const ref = event.thread!;
    const key = threadKey(ref);
    const log = (line: string) => this.log(`[${key}] ${line}`);
    const channel = this.opts.channels.find((c) => c.id === event.channel)!;
    const client = await this.client(channel, event.source);
    const thread = await client.thread(ref);
    const { repo, container, routerUrl, containerSecret } = this.opts;
    const claimed = claimThread({ paths: this.paths, repo, container, routerUrl, containerSecret, log: this.log }, channel, event, thread, workspaces);
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
        return await reply(client, ref, `⚠️ Couldn't set up the worktree: ${e instanceof Error ? e.message : e}`, log);
      }
      const ctx = this.contextFor(config);
      const env = agentEnv(this.opts.env ?? process.env, this.paths.home, credentialEnv, await client.identity());
      saveAgentEnv(this.paths.agentEnv, credentialEnv, env);
      for (const trigger of triggers) {
        await runTrigger(this.triggerDeps, { trigger, event, config, ctx, client, thread, state: claimed, cwd, env, log });
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
      const container = config.manifest.containers.find((c) => c.name === this.opts.container);
      if (!container) throw new Error(`The config at ${config.commit} has no container "${this.opts.container}"`);
      const containerFiles = resolveFiles(container.files, config.root);
      writeFiles(containerFiles, this.paths.home);
      ctx = runtimeContext(config.root, {
        home: this.paths.home,
        runnerPrompt: runnerPrompt(),
        containerFiles,
        env: withoutPrivate(this.opts.env ?? process.env),
      });
      this.contexts.set(config.commit, ctx);
    }
    return ctx;
  }

  /** Marks runs a restart interrupted and says so on their threads. */
  reportInterrupted() {
    return reportInterrupted({ threads: this.paths.threads, channels: this.opts.channels, client: (channel, source) => this.client(channel, source), log: this.log });
  }
}
