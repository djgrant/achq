import type {
  AccessProvider, Agent, Channel, ChannelEvent, ContainerHost, Credential, Data, Message, Plan, Thread, ThreadRef,
} from "./primitives.ts";

// ─── Router ──────────────────────────────────────────────────────────────────
// Public. Holds provider secrets and the plans' plain-data parts.

type RouterDeps = {
  channels: Channel[];
  providers: AccessProvider[];
  secrets: Record<string, string>; // by provider id
  plans: () => Plan[];             // pushed by the deployer, stored on the volume
  inbox: Inbox;
  containerHost: ContainerHost;
  deployerUrl: string;
};

export const route = async (deps: RouterDeps, request: Request): Promise<Response> => {
  const body = await request.text();
  const channel = await firstAsync(deps.channels, (c) => c.verify(request, body));
  if (!channel) return new Response("bad signature", { status: 401 });

  const event = channel.parse(request, body);
  if (!event) return new Response("ignored");

  const targets = event.type.startsWith("installation") || event.type === "push"
    ? [{ kind: "deployer" as const }]
    : containersFor(deps, channel, event).map((t) => ({ kind: "container" as const, ...t }));
  if (!targets.length) return new Response("no match");

  // Persisted before answering, so a crash doesn't lose it.
  await deps.inbox.put(event.delivery, { event, targets });
  void forward(deps, event); // reach() retries while a container wakes; deletes from the inbox when done
  return new Response("accepted", { status: 202 });
};

/** Event → its thread → the workspace that claims it → that workspace's container. */
const containersFor = (deps: RouterDeps, channel: Channel, event: ChannelEvent) =>
  deps.plans().flatMap((plan) => {
    if (event.repo && plan.repo !== event.repo) return [];
    const triggered = plan.triggers.some((t) => channel.eventSelector(t.event).matches(event));
    if (!triggered) return [];
    // The router only knows the thread's ref here; labels come from the event payload.
    const labels = labelsOf(event);
    const workspace = plan.workspaces.find((w) => channel.threadSelector(w.threads).matches({ ref: event.thread, labels }));
    return workspace ? [{ repo: plan.repo, container: workspace.container }] : [];
  });

/** Private port only. A container proves who it is; it gets credentials for its own policies. */
export const credentials = async (deps: RouterDeps, repo: string, container: string): Promise<Credential[]> => {
  const plan = deps.plans().find((p) => p.repo === repo);
  const spec = plan?.containers.find((c) => c.name === container);
  if (!spec) throw new Error(`No container ${container} in ${repo}`);
  const byProvider = groupBy(spec.policies, (p) => p.provider);
  const minted = await Promise.all(
    Object.entries(byProvider).map(([id, policies]) =>
      provider(deps.providers, id).mint(policies.map((p) => p.policy), repo, deps.secrets[id]),
    ),
  );
  return minted.flat();
};

// ─── Deployer ────────────────────────────────────────────────────────────────
// Private. Holds the host's token and the agents' tokens. Never runs repo code outside the sandbox.

type DeployerDeps = {
  containerHost: ContainerHost;
  providers: AccessProvider[];
  owners: string[];
  fetchAchqDir: (repo: string) => Promise<{ tree: string; files: Record<string, string> }>;
  evaluate: (files: Record<string, string>) => Promise<Plan>; // bundle, then run in QuickJS
  deployed: Store<{ tree: string; plan: Plan }>;
  pushPlans: (plans: Plan[]) => Promise<void>; // to the router
  report: (repo: string, status: { state: "deployed" | "failed" | "unchanged"; error?: string }) => Promise<void>; // ACHQ_STATUS
  env: (repo: string, container: string) => Record<string, string>;
};

export const deploy = async (deps: DeployerDeps, repo: string) => {
  if (!deps.owners.includes(repo.split("/")[0])) return deps.report(repo, { state: "failed", error: "owner not allowed" });

  const { tree, files } = await deps.fetchAchqDir(repo);
  const previous = await deps.deployed.get(repo);
  if (previous?.tree === tree) return deps.report(repo, { state: "unchanged" });

  const plan = await deps.evaluate(files);
  const problems = (
    await Promise.all(
      plan.containers.flatMap((c) => c.policies.map((p) => provider(deps.providers, p.provider).validate(p.policy, repo))),
    )
  ).flat();
  if (problems.length) return deps.report(repo, { state: "failed", error: problems.join("\n") });

  for (const c of plan.containers) {
    const before = previous?.plan.containers.find((p) => p.name === c.name);
    if (before && sameData(before, c)) continue;
    await deps.containerHost.ensure({ repo, name: c.name, image: c.image, env: deps.env(repo, c.name) });
  }
  // Containers no longer in the plan are left asleep; `achq up --prune` deletes them.

  await deps.deployed.set(repo, { tree, plan });
  await deps.pushPlans(await deps.deployed.all().then((all) => all.map((d) => d.plan)));
  await deps.report(repo, { state: "deployed" });
};

// ─── Container ───────────────────────────────────────────────────────────────
// Private. Runs agents. Holds only credentials scoped to its policies.

type ContainerDeps = {
  repo: string;
  name: string;
  plan: Plan;                         // its own config, evaluated again here, with agents as code
  agents: Record<string, Agent>;
  channels: Record<string, Channel>;
  providers: AccessProvider[];
  fetchCredentials: () => Promise<Credential[]>; // from the router's private port
  seen: Store<true>;                  // delivery IDs already handled
  threads: Store<ThreadState>;
  lock: (key: string, fn: () => Promise<void>) => Promise<void>;
  worktree: (key: string, branch: string, base: string) => Promise<string>;
  files: Record<string, string>;      // startup files, for session keys
  renderPrompt: (thread: Thread, messages: Message[], resuming: boolean) => string;
};

type ThreadState = { workspace: string; sessions: Record<string, { key: string; id: string; lastMessage?: string }> };

export const handle = async (deps: ContainerDeps, event: ChannelEvent) => {
  if (await deps.seen.get(event.delivery)) return;
  await deps.seen.set(event.delivery, true);

  const channel = deps.channels[event.channel];
  const triggers = deps.plan.triggers.filter((t) => channel.eventSelector(t.event).matches(event));
  if (!triggers.length || !event.actor.trusted) return;

  const thread = await channel.thread(event.thread);
  const key = threadKey(event.thread);
  const state = (await deps.threads.get(key)) ?? claim(deps, channel, thread);
  if (!state) return; // no workspace in this container claims the thread
  const workspace = deps.plan.workspaces.find((w) => w.name === state.workspace)!;

  await channel.acknowledge(event);
  await deps.lock(key, async () => {
    const cwd = await deps.worktree(key, fill(workspace.branch, thread.vars), workspace.base);
    const env = await installAll(deps.providers, await deps.fetchCredentials(), cwd);
    const messages = (await channel.messages(event.thread)).filter((m) => m.trusted);

    for (const trigger of triggers) {
      const agent = deps.agents[trigger.agent];
      const sessionKey = agent.sessionKey(deps.files);
      const session = state.sessions[agent.name];
      const resuming = session?.key === sessionKey;
      const fresh = resuming ? messages.filter((m) => m.id > (session.lastMessage ?? "")) : messages;
      if (resuming && !fresh.length) continue;

      const configDir = `${cwd}/../.agents/${agent.name}`;
      await agent.configure(configDir);
      const result = await agent.run({
        thread: event.thread, event, cwd, configDir, env,
        prompt: deps.renderPrompt(thread, fresh, resuming),
        session: resuming ? session.id : undefined,
        signal: AbortSignal.timeout(6 * 60 * 60_000),
      });
      state.sessions[agent.name] = { key: sessionKey, id: result.session, lastMessage: messages.at(-1)?.id };
      await deps.threads.set(key, state);
      await channel.reply(event.thread, result.error ? `⚠️ ${result.error}` : result.reply);
    }
  });
};

/** The first workspace whose selector matches claims the thread, for good. */
const claim = (deps: ContainerDeps, channel: Channel, thread: Thread): ThreadState | undefined => {
  const workspace = deps.plan.workspaces.find((w) => channel.threadSelector(w.threads).matches(thread));
  return workspace && { workspace: workspace.name, sessions: {} };
};

// ─── Plumbing ────────────────────────────────────────────────────────────────

interface Store<T> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T): Promise<void>;
  all(): Promise<T[]>;
}

interface Inbox {
  put(delivery: string, entry: { event: ChannelEvent; targets: unknown[] }): Promise<void>;
  done(delivery: string): Promise<void>;
  pending(): Promise<string[]>; // replayed on startup
}

declare const forward: (deps: RouterDeps, event: ChannelEvent) => Promise<void>;
declare const labelsOf: (event: ChannelEvent) => string[];
declare const firstAsync: <T>(items: T[], test: (item: T) => Promise<boolean>) => Promise<T | undefined>;
declare const groupBy: <T>(items: T[], key: (item: T) => string) => Record<string, T[]>;
declare const sameData: (a: Data, b: Data) => boolean;
declare const threadKey: (ref: ThreadRef) => string;
declare const fill: (template: string, vars: Record<string, string>) => string;
declare const installAll: (providers: AccessProvider[], credentials: Credential[], dir: string) => Promise<Record<string, string>>;
const provider = (providers: AccessProvider[], id: string) => providers.find((p) => p.id === id)!;
