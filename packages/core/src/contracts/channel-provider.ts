import type { ChannelCredential, Credential } from "../model/credentials.ts";
import type { ChannelEvent, ParsedEvent } from "../model/events.ts";
import type { SelectorData } from "../model/resource-data.ts";
import type { Message, Thread, ThreadRef } from "../model/threads.ts";
import type { SourceSettings } from "../wire/protocol.ts";

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
