import type { Data } from "../resources/data.ts";
import type { SelectorData } from "../resources/config.ts";
import type { RepoPlan } from "../resources/repo-plan.ts";
import type { ManagedResource } from "../resources/resource.ts";
import type { Installation, SourceSettings } from "../wire/protocol.ts";

/** A thread's identity, qualified by channel. `id` is e.g. `notationlabs/yieldstar#42`. */
export type ThreadRef = { channel: string; id: string };

export const threadKey = (ref: ThreadRef) => `${ref.channel}:${ref.id}`;

/** An event a channel delivered, normalised. Kept small, because the router persists and forwards it. */
export type ChannelEvent = ChannelEventBase &
  (
    | { host?: undefined; installation?: undefined; configChanged?: undefined }
    /** For the deployer: the repos the source was installed on (`added`) or removed from, on the `RepoHost` `host`. */
    | { host: string; installation: { added: string[]; removed: string[] }; configChanged?: undefined }
    /** For the deployer: whether the repo's `.achq/` may have changed on its default branch, on the `RepoHost` `host`. */
    | { host: string; configChanged: boolean; installation?: undefined }
  );

type ChannelEventBase = {
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
  value: string;
  /** ISO time. */
  expiresAt: string;
  /** What it covers, for the access provider or channel that minted it. e.g. `{ app, repos, permissions }`. */
  scope: { [key: string]: Data };
};

/** For the container's runner: minted by the channel it names. */
export type ChannelCredential = Credential & { channel: string };

/** Where threads live. Hears events, reads threads, posts replies, decides who's trusted. */
export interface Channel {
  readonly id: string;

  // ── Router side: trusted achq code, holding the channel's secrets ──
  /** Checks a delivery's signature. Returns the source it came from, or undefined if it's not genuine. */
  verify(headers: Headers, body: string): Promise<string | undefined>;
  /** Normalises a verified delivery, or returns undefined for ones achq never acts on. */
  parse(source: string, headers: Headers, body: string): ChannelEvent | undefined;
  /** A credential the container's runner (not the agent) uses for `ChannelClient`. Its scope names the `source`. */
  mintClient(source: string, repo: string): Promise<ChannelCredential>;
  /** The repos each source is installed on, and the repo host they're on: what the deployer serves. */
  installations(): Promise<Installation[]>;
  /** What each source is set up to send and allow, for the deployer's checks. */
  sources(): Promise<SourceSettings[]>;

  // ── Both sides: selectors are plain data ──
  matchEvent(selector: SelectorData, event: ChannelEvent): boolean;
  matchThread(selector: SelectorData, thread: { ref: ThreadRef; labels: string[] }): boolean;

  // ── Container side ──
  client(credential: Credential): ChannelClient;

  // ── The CLI, acting as you ──
  /**
   * What makes `repo` subscribe to the sources its config names (`installed`),
   * or leave them: one resource per source, named after it, for `achq install`
   * and `uninstall` to plan. Pure: the resources read and change things as you
   * when they're planned and applied. They become what `installations()` lists.
   */
  installation(repo: string, plan: RepoPlan, installed: boolean): ManagedResource[];
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
