import { type ChannelClient, type ChannelProvider, type ChannelEvent, type ContainerEnvelope, type PolicyProvider, type RepoManifest, type RuntimeFactory, type Thread, threadKey } from "@achq/core";
import { keyedQueue, memo } from "@achq/utils/async";
import { errorDetail, errorMessage } from "@achq/utils/errors";
import { withLock } from "@achq/utils/flock";
import { ensureDirs } from "@achq/utils/fs";
import { agentEnv, saveAgentEnv } from "./agent-env.ts";
import { claimThread } from "./claim.ts";
import type { LoadedConfig } from "./config/loader.ts";
import { DEFAULT_MAX_RUNS, DEFAULT_RUN_TIMEOUT_MINUTES, MINUTE_MS } from "./constants.ts";
import { Credentials } from "./credentials.ts";
import { firstDelivery } from "./deliveries.ts";
import { eventsHandler } from "./events-handler.ts";
import { writeFiles } from "./files.ts";
import { reportInterrupted } from "./interrupted.ts";
import { keepAwake, stayAwake } from "./keep-awake.ts";
import { logFailure } from "./log-failure.ts";
import { configLoadFailed, worktreeFailed } from "./messages.ts";
import { paths as layout, type Paths } from "./paths.ts";
import { fillBranch } from "./branch.ts";
import { reply } from "./reply.ts";
import { ensureWorktree, fetchMirror } from "./repo.ts";
import { runTrigger, type TriggerDeps } from "./run-trigger.ts";
import { containerContext } from "./runtime-context.ts";
import { defaultRuntimes } from "./runtimes.ts";
import { RunSlots } from "./slots.ts";

export type RunnerOptions = {
  /** `owner/name`. */
  repo: string;
  /** This container's name in the repo's config. */
  container: string;
  channelProviders: ChannelProvider[];
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
  /** Outbound traffic while runs are going, so the container provider doesn't sleep the container. Defaults to fetching ENV.keepAwakeUrl, when it's set. */
  keepAwake?: () => Promise<unknown>;
  log?: (line: string) => void;
};

type Workspace = RepoManifest["workspaces"][number];
type Trigger = RepoManifest["triggers"][number];
type Env = Record<string, string | undefined>;

/** This container's workspaces for the event's channel, and the triggers the event matches. */
type Matched = { workspaces: Workspace[]; triggers: Trigger[] };

export class Runner {
  readonly paths: Paths;
  readonly credentials: Credentials;
  /** The HTTP handler: `GET /` health, `POST /events` signed by the router. */
  readonly fetch: (req: Request) => Promise<Response>;
  /** One thread's runs go one after another. */
  private enqueue = keyedQueue();
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
      accept: (envelope) => this.track(this.handle(envelope).catch((e) => this.log(`[${envelope.event.delivery}] ${errorDetail(e)}`))),
    });
    this.slots = this.runSlots(opts.maxRuns ?? DEFAULT_MAX_RUNS);
    this.triggerDeps = {
      paths: this.paths,
      runtimes: opts.runtimes ?? defaultRuntimes,
      runTimeoutMs: opts.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MINUTES * MINUTE_MS,
      now: this.now,
    };
    ensureDirs(this.paths.home, this.paths.threads, this.paths.deliveries);
  }

  /** Resolves when everything in flight has finished. For tests and shutdown. */
  async idle() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private track(p: Promise<unknown>) {
    this.pending.add(p);
    p.finally(() => this.pending.delete(p));
  }

  private get baseEnv(): Env {
    return this.opts.env ?? process.env;
  }

  /**
   * `max` slots that keep the container awake while any run is going. A long
   * tool call can go minutes without outbound traffic. Each tick also
   * refreshes credentials near expiry, and `install` rewrites them in place
   * for the running agents.
   */
  private runSlots(max: number) {
    const ping = this.opts.keepAwake ?? keepAwake(this.baseEnv);
    const tick = () => {
      void logFailure(this.credentials.get(), this.log, "credentials");
      ping?.().catch(() => {});
    };
    let stop = () => {};
    return new RunSlots(max, {
      onBusy: () => {
        stop = stayAwake(tick);
      },
      onIdle: () => stop(),
    });
  }

  /** Handles one event; resolves once its runs (if any) are queued. */
  async handle({ event, commit }: ContainerEnvelope): Promise<void> {
    const tag = `[${event.delivery}]`;
    if (!firstDelivery(this.paths.deliveries, event.delivery)) return this.log(`${tag} already handled`);
    const channel = this.channelOf(event);
    if (!channel || !event.thread) return;
    const refused = refusal(event);
    if (refused) return this.log(`${tag} ignored: ${refused}`);

    const config = await this.loadOrReport(channel, event, commit);
    if (!config) return;
    const matched = matching(config, this.opts.container, channel, event);
    if (!matched) return this.log(`${tag} no trigger here matches ${event.type}`);

    const key = threadKey(event.thread);
    const queued = this.enqueue(key, () => this.slots.run(() => this.work(event, config, matched)));
    this.track(queued.catch((e) => this.log(`[${key}] ${errorDetail(e)}`)));
  }

  private channelOf(event: ChannelEvent) {
    return this.opts.channelProviders.find((c) => c.id === event.channel);
  }

  /** The config at `commit`, or undefined once the failure is posted on the thread. */
  private async loadOrReport(channel: ChannelProvider, event: ChannelEvent, commit: string): Promise<LoadedConfig | undefined> {
    try {
      return await this.opts.loadConfig(commit);
    } catch (e) {
      // The router only forwards events some trigger matches, so someone is waiting on a reply.
      const message = errorMessage(e);
      this.log(`[${event.delivery}] couldn't load the config at ${commit}: ${message}`);
      const client = await this.client(channel, event.source);
      await reply(client, event.thread!, configLoadFailed(commit, message), this.log);
      return undefined;
    }
  }

  private async client(channel: ChannelProvider, source: string) {
    return channel.client(await this.credentials.channel(channel.id, source));
  }

  /** Claims the thread, then runs each matched trigger in its worktree, holding the thread's lock. */
  private async work(event: ChannelEvent, config: LoadedConfig, { workspaces, triggers }: Matched) {
    const ref = event.thread!;
    const key = threadKey(ref);
    const log = (line: string) => this.log(`[${key}] ${line}`);
    const channel = this.channelOf(event)!;
    const client = await this.client(channel, event.source);
    const thread = await client.thread(ref);
    const state = this.claim(channel, event, thread, workspaces);
    if (!state) return log("no workspace in this container claims it");
    const workspace = workspaces.find((w) => w.name === state.workspace)!;

    await logFailure(client.acknowledge(event), log, "acknowledge failed");
    await withLock(this.paths.lock(workspace.name, key), async () => {
      const { env: credentialEnv } = await this.credentials.get();
      let cwd: string;
      try {
        cwd = await this.prepareWorktree(workspace, key, thread, { ...process.env, ...credentialEnv });
      } catch (e) {
        return reply(client, ref, worktreeFailed(errorMessage(e)), log);
      }
      const ctx = this.contextFor(config);
      const env = await this.agentEnvFor(client, credentialEnv);
      for (const trigger of triggers) {
        await runTrigger(this.triggerDeps, { trigger, event, config, ctx, client, thread, state, cwd, env, log });
      }
    });
  }

  private claim(channel: ChannelProvider, event: ChannelEvent, thread: Thread, workspaces: Workspace[]) {
    const { repo, container, routerUrl, containerSecret } = this.opts;
    return claimThread({ paths: this.paths, repo, container, routerUrl, containerSecret, log: this.log }, channel, event, thread, workspaces);
  }

  /** The thread's worktree, after fetching the mirror. `gitEnv` carries git's credentials. */
  private async prepareWorktree(workspace: Workspace, key: string, thread: Thread, gitEnv: Env): Promise<string> {
    const cwd = this.paths.worktree(workspace.name, key);
    await fetchMirror(this.paths.mirror, this.opts.repoUrl, gitEnv);
    await ensureWorktree(this.paths.mirror, cwd, fillBranch(workspace.branch, thread.vars), workspace.base, gitEnv);
    return cwd;
  }

  /** The env agents run with, saved for `resume`. */
  private async agentEnvFor(client: ChannelClient, credentialEnv: Record<string, string>) {
    const env = agentEnv(this.baseEnv, this.paths.home, credentialEnv, await client.identity());
    saveAgentEnv(this.paths.agentEnv, credentialEnv, env);
    return env;
  }

  /** Session keys and runtimes read the container's startup files, so they're written here, once per config. */
  private contextFor = memo((config: LoadedConfig) => {
    const container = config.manifest.containers.find((c) => c.name === this.opts.container);
    if (!container) throw new Error(`The config at ${config.commit} has no container "${this.opts.container}"`);
    const ctx = containerContext(config, this.paths.home, this.baseEnv, container);
    writeFiles(ctx.containerFiles, this.paths.home);
    return ctx;
  });

  /** Marks runs a restart interrupted and says so on their threads. */
  reportInterrupted() {
    return reportInterrupted({ threads: this.paths.threads, channelProviders: this.opts.channelProviders, client: (channel, source) => this.client(channel, source), log: this.log });
  }
}

/** Why the runner won't act on the event, if it won't: only trusted people start runs. */
const refusal = (event: ChannelEvent): string | undefined => {
  if (!event.actor?.trusted || event.actor.bot) return "actor isn't a trusted person";
  return undefined;
};

/** What in the config the event is for here, or undefined if nothing is. */
const matching = (config: LoadedConfig, container: string, channel: ChannelProvider, event: ChannelEvent): Matched | undefined => {
  const workspaces = config.manifest.workspaces.filter((w) => w.container === container && w.threads.channel === channel.id);
  const triggers = config.manifest.triggers.filter((t) => t.event.channel === channel.id && channel.matchEvent(t.event, event));
  return workspaces.length && triggers.length ? { workspaces, triggers } : undefined;
};
