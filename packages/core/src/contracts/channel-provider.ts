import type { Json } from "@achq/utils/json";
import type { SelectorData } from "../resources/config.ts";
import type { SourceSettings } from "../wire/protocol.ts";

/** A thread's identity, qualified by channel. `id` is e.g. `notationlabs/yieldstar#42`. */
export type ThreadRef = { channel: string; id: string };

export const threadKey = (ref: ThreadRef) => `${ref.channel}:${ref.id}`;

/** An event on a thread a channel delivered, normalised, for containers. Kept small, because the router persists and forwards it. */
export type ChannelEvent = {
  channel: string;
  /** Which configured sender it came through, e.g. a GitHub App's slug. Selectors name one. */
  source: string;
  /** Unique per delivery; containers ignore ones they've handled. */
  delivery: string;
  /** e.g. "issue_comment.created", "issues.edited" */
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
  detail: { [key: string]: Json };
};

/**
 * For the deployer: repos on the infra's code host to deploy, because
 * a source was installed on them or their `.achq/` may have changed on their
 * default branch, and repos to uninstall, because it was removed from them.
 * What the router forwards, once it has decided which repos.
 */
export type DeployerEvent = {
  /** Unique per delivery; the deployer ignores ones it's handled. */
  delivery: string;
  /** e.g. "push", "installation_repositories.added", "deploy.requested" */
  type: string;
  deploy: string[];
  uninstall: string[];
};

/** A `DeployerEvent` as its channel parses it, before the router decides which repos go to the deployer. */
export type RepoEvent = DeployerEvent & {
  /** For a push: only repos already deployed are deployed again. An install is what deploys a repo first. The router filters on it, and doesn't forward it. */
  onlyIfDeployed: boolean;
};

/** Whether a trusted person, not a bot, caused the event: only they start runs. The channel decides who's trusted; this is achq's rule for what that's for. */
export const fromTrustedPerson = (event: ChannelEvent) => Boolean(event.actor?.trusted && !event.actor.bot);

/** A delivery as its channel parses it, tagged with where it goes: a repo event to the deployer, an event on a thread to containers. */
export type ParsedEvent = { to: "deployer"; event: RepoEvent } | { to: "containers"; event: ChannelEvent };

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
  /** Written by this channel's own identity, i.e. an earlier reply. */
  own: boolean;
  body: string;
  at: string;
  /** For the opening post: whether it changed since `since` in `messages()`. */
  edited?: boolean;
};

export type Credential = {
  value: string;
  /** ISO time. */
  expiresAt: string;
  /** What it covers, for the policy provider or channel that minted it. e.g. `{ source, repos, permissions }`. */
  scope: { [key: string]: Json };
};

/** For the container's runner: minted by the channel it names. */
export type ChannelCredential = Credential & { channel: string };

/** Where threads live. Hears events, reads threads, posts replies, decides who's trusted. */
export interface ChannelProvider {
  readonly id: string;

  // ── Router side: trusted achq code, holding the channel's secrets ──
  /** Checks a delivery's signature. Returns the source it came from, or undefined if it's not genuine. */
  verify(headers: Headers, body: string): Promise<string | undefined>;
  /** Normalises a verified delivery: an event on a thread, one about which repos to deploy, or undefined for ones achq never acts on. */
  parse(source: string, headers: Headers, body: string): ParsedEvent | undefined;
  /** A credential the container's runner (not the agent) uses for `ChannelClient`. Its scope names the `source`. */
  mintClient(source: string, repo: string): Promise<ChannelCredential>;
  /** What each source is set up to send and allow, for the deployer's checks. */
  sources(): Promise<SourceSettings[]>;

  // ── Both sides: selectors are plain data ──
  matchEvent(selector: SelectorData, event: ChannelEvent): boolean;
  matchThread(selector: SelectorData, thread: { ref: ThreadRef; labels: string[] }): boolean;

  // ── Container side, and the router's own replies ──
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
