/** Anything declared in a config. Constructing one registers it in the graph. */
export abstract class Resource<Inputs> {
  constructor(
    readonly name: string,
    readonly inputs: Inputs,
  ) {}
}

/** Something that exists somewhere (Railway, GitHub) and is brought in line with its inputs. */
export interface Deployable<State> {
  /** What exists now, or undefined if nothing does. */
  read(): Promise<State | undefined>;
  /** What would change. A dry run stops here. */
  diff(current: State | undefined): Change[];
  apply(changes: Change[]): Promise<State>;
}

export type Change = { kind: "create" | "update" | "delete"; what: string; detail?: string };

/** Plain data: anything that crosses into the router. No functions. */
export type Data = string | number | boolean | null | Data[] | { [key: string]: Data };

// ─── Channels and threads ────────────────────────────────────────────────────

/** A thread's identity, qualified by channel: `github:notationlabs/yieldstar#42`. */
export type ThreadRef = { channel: string; id: string };

export type Message = { id: string; author: string; trusted: boolean; body: string; at: string };

/** An event a channel delivered, normalised. */
export type ChannelEvent = {
  channel: string;
  delivery: string;      // for deduplication
  type: string;          // "issue_comment.created"
  repo?: string;         // when the channel knows it
  thread: ThreadRef;
  actor: { login: string; trusted: boolean };
  text?: string;         // the text that matched, e.g. a comment body
  previousText?: string; // for edits
  raw: unknown;
};

/** Where threads live. Hears events, reads threads, posts replies, decides who's trusted. */
export type Thread = { ref: ThreadRef; title: string; url: string; labels: string[]; vars: Record<string, string> };

export interface Channel {
  readonly id: string; // "github"

  // Router side: plain, trusted achq code.
  verify(request: Request, body: string): Promise<boolean>;
  parse(request: Request, body: string): ChannelEvent | undefined;
  /** Rebuilds selectors from the plan's plain data, since the router never runs repo code. */
  eventSelector(data: Data): EventSelector;
  threadSelector(data: Data): ThreadSelector;

  // Container side.
  thread(ref: ThreadRef): Promise<Thread>; // `vars` fill branch templates: {number}, {title}
  messages(ref: ThreadRef): Promise<Message[]>; // the body first, then comments
  reply(ref: ThreadRef, body: string): Promise<void>;
  acknowledge(event: ChannelEvent): Promise<void>; // e.g. the 👀 reaction
}

/** Which events start a run. Plain data, matched in the router. */
export interface EventSelector {
  readonly channel: string;
  toData(): Data;
  matches(event: ChannelEvent): boolean;
}

/** Which threads a workspace claims. Plain data, matched in the router and the container. */
export interface ThreadSelector {
  readonly channel: string;
  toData(): Data;
  matches(thread: { ref: ThreadRef; labels: string[] }): boolean;
}

// ─── Access ──────────────────────────────────────────────────────────────────

export type Credential = { value: string; expiresAt?: string };

/**
 * Turns policies into credentials. Router and container load the same code and
 * each calls its own part. Comes from achq or the infra repo, never a subscriber repo.
 */
export interface AccessProvider<P extends Data = Data> {
  readonly id: string; // "github"

  // Router side. Only the router holds `secret`.
  validate(policy: P, repo: string): Promise<string[]>; // problems, empty if fine
  mint(policies: P[], repo: string, secret: string): Promise<Credential[]>;

  // Container side: makes credentials usable by agents (files, env, git helpers).
  install(credentials: Credential[], dir: string): Promise<{ env: Record<string, string> }>;
}

/** What a container can access. Plain data, interpreted by its provider. */
export class Policy<P extends Data = Data> extends Resource<{ provider: AccessProvider<P>; policy: P }> {}

// ─── Agents ──────────────────────────────────────────────────────────────────

export type RunContext = {
  thread: ThreadRef;
  event: ChannelEvent;
  cwd: string;                  // the workspace's worktree
  configDir: string;            // this agent's own config directory
  env: Record<string, string>;  // credentials from AccessProvider.install
  prompt: string;               // rendered from the thread's trusted messages
  session?: string;             // to resume, if the session key still matches
  signal: AbortSignal;          // run timeout
};

export type RunResult = { session: string; reply: string; error?: string };

/** Who does the work. Takes config; the implementation decides how to apply it. */
export interface Agent {
  readonly name: string;
  /** A hash of everything in the cached prefix. A different key means a fresh session. */
  sessionKey(files: Record<string, string>): string;
  /** Writes the agent's config into its own config directory. */
  configure(configDir: string): Promise<void>;
  run(context: RunContext): Promise<RunResult>;
  /** The command to open a session interactively, for `achq resume`. */
  resumeCommand(session: string): string[];
}

// ─── Repo resources ──────────────────────────────────────────────────────────

export class Container extends Resource<{
  image: string;                                  // relative to .achq/
  policies: Policy[];
  files?: Record<string, string | Data>;          // written at startup; a path or contents
}> {}

export class Workspace extends Resource<{
  container: Container;
  threads: ThreadSelector;
  branch: string;                                 // template, e.g. "issue-{number}"
  base: string;
}> {}

export class Trigger extends Resource<{
  event: EventSelector;
  agent: Agent;
}> {}

// ─── Hosts ───────────────────────────────────────────────────────────────────

export type ServiceState = "building" | "running" | "sleeping" | "failed" | "missing";

/** Where containers run. Railway is the first. */
export interface ContainerHost {
  ensure(spec: {
    repo: string;
    name: string;
    image: string;
    env: Record<string, string>;
  }): Promise<{ changed: boolean }>;
  state(repo: string, name: string): Promise<ServiceState>;
  /** Reaches a container, waking it if it's asleep. */
  reach(repo: string, name: string, path: string, init: RequestInit): Promise<Response>;
  shell(repo: string, name: string, command: string[]): Promise<number>;
  delete(repo: string, name: string): Promise<void>;
}

/** Where the router runs: public, always on, with a volume. */
export interface RouterHost {
  ensure(spec: { env: Record<string, string> }): Promise<{ url: string; changed: boolean }>;
  setSecret(name: string, value: string): Promise<void>; // App keys go straight here
}

// ─── Infra resources ─────────────────────────────────────────────────────────

/** Receives events, persists them, filters and forwards them; mints credentials. */
export class Router extends Resource<{ host: RouterHost }> {}

/** Evaluates repo config and deploys its containers. */
export class Deployer extends Resource<{
  router: Router;
  containerHost: ContainerHost;
  owners: string[];
}> {}

/**
 * The plain-data plan the deployer gets from evaluating a repo's config in the
 * sandbox. The router gets the event, thread and policy parts.
 */
export type Plan = {
  repo: string;
  containers: { name: string; image: string; policies: { provider: string; policy: Data }[] }[];
  workspaces: { name: string; container: string; threads: Data; branch: string; base: string }[];
  triggers: { name: string; event: Data; agent: string }[];
};
