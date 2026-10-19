import type { Data } from "../resources/data.ts";
import type { SelectorData } from "../resources/config.ts";
import type { RepoPlan } from "../resources/repo-plan.ts";
import type { Installation, SourceSettings } from "../wire/protocol.ts";

/** A thread's identity, qualified by channel. `id` is e.g. `notationlabs/yieldstar#42`. */
export type ThreadRef = { channel: string; id: string };

export const threadKey = (ref: ThreadRef) => `${ref.channel}:${ref.id}`;

/** An event a channel delivered, normalised. Kept small, because the router persists and forwards it. */
export type ChannelEvent = {
  channel: string;
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
  /** For the deployer: the repos the source was installed on (`added`) or removed from. */
  installation?: { added: string[]; removed: string[] };
  /** For the deployer: the repo's `.achq/` may have changed on its default branch. */
  configChanged?: boolean;
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
  /** What it covers, for the `install` of the access provider or channel that minted it. e.g. `{ app, repos, permissions }`. */
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
  /** A credential the container's runner (not the agent) uses for `ChannelClient`. Its scope names the `source`. */
  mintClient(source: string, repo: string): Promise<Credential>;
  /** The repos each source is installed on: what the deployer serves. */
  installations(): Promise<Installation[]>;
  /** What each source is set up to send and allow, for the deployer's checks. */
  sources(): Promise<SourceSettings[]>;

  // ── Both sides: selectors are plain data ──
  matchEvent(selector: SelectorData, event: ChannelEvent): boolean;
  matchThread(selector: SelectorData, thread: { ref: ThreadRef; labels: string[] }): boolean;

  // ── Container side ──
  client(credential: Credential): ChannelClient;

  // ── The CLI, acting as you ──
  /** Checks the source the config names can serve it, then installs it on the repo (unless it's a dry run). */
  install(repo: string, plan: RepoPlan, options: { dryRun: boolean; open(url: string): Promise<void>; log(line: string): void }): Promise<void>;
  /** Removes the repo from its source. Returns what to tell you. */
  uninstall(repo: string, plan: RepoPlan): Promise<string>;
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
