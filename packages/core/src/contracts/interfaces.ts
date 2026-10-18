// The extension points: what a platform (GitHub, Railway, Claude) implements.
// The router, deployer and container are written against these.
import type { Data } from "../model/data.ts";
import type { PolicyData, RepoPlan, SelectorData } from "../model/resources.ts";

// ─── Channels ────────────────────────────────────────────────────────────────

/** A thread's identity, qualified by channel. `id` is e.g. `notationlabs/yieldstar#42`. */
export type ThreadRef = { channel: string; id: string };

export const threadKey = (ref: ThreadRef) => `${ref.channel}:${ref.id}`;

/** An event a channel delivered, normalised. Small: the router persists and forwards it. */
export type ChannelEvent = {
  channel: string; // "github"
  /** Which configured sender it came through, e.g. the App's slug. Selectors name one. */
  source: string;
  /** Unique per delivery; containers and the deployer ignore ones they've handled. */
  delivery: string;
  /** e.g. "issue_comment.created", "issues.edited", "push", "installation_repositories.added" */
  type: string;
  repo?: string;
  thread?: ThreadRef;
  /** The thread's labels as of the event, when the channel says. */
  labels?: string[];
  actor?: { login: string; trusted: boolean; bot: boolean };
  /** The text the event carries (a comment or issue body), and for edits, the text before. */
  text?: string;
  previousText?: string;
  /** The message the event is about, as a `Message.id` from `ChannelClient.messages`, when it's one. */
  message?: string;
  /** Anything else the channel needs later, e.g. the comment ID to react to. */
  detail: { [key: string]: Data };
};

export type Thread = {
  ref: ThreadRef;
  title: string;
  url: string;
  labels: string[];
  /** Fills branch templates: `{number}`, `{title}` (slugified). */
  vars: Record<string, string>;
};

/** The thread's opening post first, then replies in order. */
export type Message = {
  id: string;
  author: string;
  trusted: boolean;
  /** Written by this channel's own identity (the App), i.e. an earlier reply. */
  own: boolean;
  body: string;
  at: string;
  /** For the opening post: whether it changed since `since` in `messages()`. */
  edited?: boolean;
};

export type Credential = {
  provider: string;
  value: string;
  /** ISO time. */
  expiresAt: string;
  /** What it covers, for the provider's `install`. e.g. `{ app, repos, permissions }`. */
  scope: { [key: string]: Data };
};

/** Where threads live. Hears events, reads threads, posts replies, decides who's trusted. */
export interface Channel {
  readonly id: string;

  // ── Router side: trusted achq code, holding the channel's secrets ──
  /** Checks a delivery's signature. Returns the source it came from, or undefined if it's not genuine. */
  verify(headers: Headers, body: string): Promise<string | undefined>;
  /** Normalises a verified delivery, or returns undefined for ones achq never acts on. */
  parse(source: string, headers: Headers, body: string): ChannelEvent | undefined;
  /** A credential the container's runner (not the agent) uses for `ChannelClient`. */
  mintClient(source: string, repo: string): Promise<Credential>;

  // ── Both sides: selectors are plain data ──
  matchEvent(selector: SelectorData, event: ChannelEvent): boolean;
  matchThread(selector: SelectorData, thread: { ref: ThreadRef; labels: string[] }): boolean;

  // ── Container side ──
  client(credential: Credential): ChannelClient;
}

export interface ChannelClient {
  thread(ref: ThreadRef): Promise<Thread>;
  messages(ref: ThreadRef): Promise<Message[]>;
  reply(ref: ThreadRef, body: string): Promise<void>;
  /** e.g. the 👀 reaction on the comment that triggered a run. */
  acknowledge(event: ChannelEvent): Promise<void>;
  /** Who replies: used for git commits. */
  identity(): Promise<{ name: string; email: string }>;
}

// ─── Access ──────────────────────────────────────────────────────────────────

/**
 * Turns policies into credentials. The router and container load the same code
 * and each calls its own part; only the router's instance has the secrets.
 * Comes from achq or the infra repo, never a subscriber repo.
 */
export interface AccessProvider {
  readonly id: string;
  /** Router: problems with a policy for `repo`, empty if fine. */
  validate(policy: PolicyData, repo: string): Promise<string[]>;
  /** Router: credentials covering `policies`, for a container in `repo`. */
  mint(policies: PolicyData[], repo: string): Promise<Credential[]>;
  /** Container: makes credentials usable by agents (files under `dir`, env). Called again on refresh. */
  install(credentials: Credential[], dir: string): Promise<{ env: Record<string, string> }>;
}

// ─── Agents ──────────────────────────────────────────────────────────────────

export type RunContext = {
  thread: ThreadRef;
  /** The workspace's worktree. */
  cwd: string;
  /** This agent's own config directory. */
  configDir: string;
  env: Record<string, string>;
  prompt: string;
  /** Resume this session, or start `newSession`. */
  session: { resume: string } | { new: string };
  signal: AbortSignal;
  log: (line: string) => void;
};

export type RunResult = { reply: string; error?: string };

/** The runtime side of an Agent resource. */
export interface AgentRuntime {
  readonly name: string;
  /** A hash of everything in the cached prefix. A different key means a fresh session. */
  sessionKey(): Promise<string>;
  /** Writes the agent's config into its own config directory. */
  configure(configDir: string): Promise<void>;
  run(context: RunContext): Promise<RunResult>;
  /** The command that opens a session interactively, for `achq resume`. */
  resumeCommand(session: string, configDir: string): { argv: string[]; env: Record<string, string> };
}

// ─── Hosts ───────────────────────────────────────────────────────────────────

export type ServiceState = "building" | "running" | "sleeping" | "failed" | "missing";

export type ContainerSpec = {
  repo: string;
  name: string;
  /** Dockerfile path in the repo, e.g. `.achq/Dockerfile`. */
  dockerfile: string;
  branch: string;
  env: Record<string, string>;
};

/** Where containers run. */
export interface ContainerHost {
  /** Creates or updates the container's service and volume. Doesn't build. Returns the URL the router reaches it on. */
  ensure(spec: ContainerSpec): Promise<{ url: string; service: string }>;
  /** Builds and deploys the container from the head of its branch. */
  deploy(repo: string, name: string): Promise<void>;
  state(repo: string, name: string): Promise<ServiceState>;
  list(): Promise<{ repo: string; name: string; service: string }[]>;
  /** Deletes the service and its volume. Only `achq up --prune` calls this. */
  remove(repo: string, name: string): Promise<void>;
  /** Where to find it, for the repo CLI (`ssh`, `resume`). Not secret. */
  locate(repo: string, name: string): Promise<Record<string, string>>;
}

// ─── Router config ───────────────────────────────────────────────────────────

/** What the deployer tells the router about a deployed repo. Plain data. */
export type RouterRepoConfig = {
  repo: string;
  /** The commit whose `.achq/` config this is. Forwarded with events so containers run the same config. */
  commit: string;
  containers: { name: string; url: string; policies: PolicyData[] }[];
  workspaces: RepoPlan["workspaces"];
  triggers: { name: string; event: SelectorData }[];
};
