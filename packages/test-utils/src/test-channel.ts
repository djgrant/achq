import type { Channel, ChannelClient, ChannelCredential, ChannelEvent, Credential, Installation, ManagedResource, Message, SelectorData, SourceSettings, Thread, ThreadRef } from "@achq/core";

type TestThread = { title: string; labels: string[]; messages: Message[] };

/** A channel whose threads live in memory. It records replies, acknowledgements and the credentials its clients were given. */
export class TestChannel implements Channel {
  readonly id = "test";
  threads = new Map<string, TestThread>();
  replies: { thread: string; body: string }[] = [];
  acks: string[] = [];
  credentials: Credential[] = [];
  private ids = 0;

  ref = (n: number): ThreadRef => ({ channel: "test", id: `acme/widgets#${n}` });

  open(n: number, opts: { labels?: string[]; body?: string; author?: string; trusted?: boolean } = {}) {
    this.threads.set(this.ref(n).id, { title: `Thread ${n}`, labels: opts.labels ?? [], messages: [] });
    return this.post(n, opts.body ?? `Opening post of ${n}`, { author: opts.author, trusted: opts.trusted });
  }

  post(n: number, body: string, opts: { author?: string; trusted?: boolean; own?: boolean } = {}): Message {
    const message: Message = {
      id: String(++this.ids),
      author: opts.author ?? "dj",
      trusted: opts.trusted ?? true,
      own: opts.own ?? false,
      body,
      at: new Date(Date.UTC(2026, 9, 1, 0, this.ids)).toISOString(),
    };
    this.threads.get(this.ref(n).id)!.messages.push(message);
    return message;
  }

  /** An event, as the router would forward it. */
  event(n: number, type: "comment" | "opened", text: string, opts: { delivery?: string; trusted?: boolean; bot?: boolean; login?: string } = {}): ChannelEvent {
    return {
      channel: "test",
      source: "app",
      delivery: opts.delivery ?? `d-${Math.random().toString(36).slice(2)}`,
      type,
      repo: "acme/widgets",
      thread: this.ref(n),
      labels: this.threads.get(this.ref(n).id)?.labels,
      actor: { login: opts.login ?? "dj", trusted: opts.trusted ?? true, bot: opts.bot ?? false },
      text,
      detail: {},
    };
  }

  /** Posts a comment and returns its event. */
  comment(n: number, body: string, opts: { trusted?: boolean; delivery?: string } = {}) {
    this.post(n, body, { trusted: opts.trusted });
    return this.event(n, "comment", body, opts);
  }

  async verify() {
    return undefined;
  }
  parse() {
    return undefined;
  }
  async mintClient(): Promise<ChannelCredential> {
    throw new Error("router only");
  }
  async installations(): Promise<Installation[]> {
    throw new Error("not in tests");
  }
  async sources(): Promise<SourceSettings[]> {
    throw new Error("not in tests");
  }
  installation(): ManagedResource[] {
    throw new Error("not in tests");
  }

  matchEvent(selector: SelectorData, event: ChannelEvent) {
    return selector.type === event.type && (typeof selector.mention !== "string" || Boolean(event.text?.includes(selector.mention)));
  }

  matchThread(selector: SelectorData, thread: { labels: string[] }) {
    const labels = (selector.labels as string[] | undefined) ?? [];
    return labels.every((l) => thread.labels.includes(l));
  }

  client(credential: Credential): ChannelClient {
    this.credentials.push(credential);
    const get = (ref: ThreadRef) => {
      const t = this.threads.get(ref.id);
      if (!t) throw new Error(`no thread ${ref.id}`);
      return t;
    };
    return {
      thread: async (ref): Promise<Thread> => {
        const t = get(ref);
        const number = ref.id.split("#")[1]!;
        return { ref, title: t.title, url: `https://example.test/${number}`, labels: [...t.labels], vars: { number, title: t.title.toLowerCase().replace(/\W+/g, "-") } };
      },
      messages: async (ref) => structuredClone(get(ref).messages),
      reply: async (ref, body) => {
        this.replies.push({ thread: ref.id, body });
        this.post(Number(ref.id.split("#")[1]), body, { author: "bot", own: true, trusted: false });
      },
      acknowledge: async (event) => {
        this.acks.push(event.delivery);
      },
      identity: async () => ({ name: "widgets-bot", email: "bot@example.test" }),
    };
  }
}
