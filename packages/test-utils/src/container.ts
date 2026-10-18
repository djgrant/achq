// Real things at the container's boundaries, for tests: a git origin, a fake
// `claude` executable, a fake router and a channel whose client records.
import { $ } from "bun";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CredentialsResponse, SelectorData, AccessProvider, Channel, ChannelClient, ChannelEvent, Credential, Message, Thread, ThreadRef } from "@achq/core";
import { verifySigned } from "@achq/core/secrets";

export const tempDir = (dirs: string[]) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "achq-container-")));
  dirs.push(dir);
  return dir;
};

// ─── Git ─────────────────────────────────────────────────────────────────────

export const CONFIG = `
import { Claude, Container, EventSelector, ThreadSelector, Trigger, Workspace } from "achq";
import { settingsFor } from "./lib/settings.ts";

const dev = new Container("dev", { image: "./Dockerfile", files: { "~/.config/tool.toml": "./tool.toml" } });
new Workspace("docs", { container: dev, threads: new ThreadSelector({ channel: "test", labels: ["docs"] }), branch: "docs/{number}", base: "docs" });
new Workspace("issues", { container: dev, threads: new ThreadSelector({ channel: "test" }), branch: "issue-{number}", base: "main" });

const coder = new Claude("coder", { model: "claude-opus-5-5", effort: "high", systemPrompt: "./prompts/coder.md", settings: settingsFor("coder") });
const triage = new Claude("triage", { model: "claude-haiku-5-5", effort: "max", systemPrompt: "./prompts/triage.md" });

new Trigger("mention", { event: new EventSelector({ channel: "test", type: "comment", mention: "@claude" }), agent: coder });
new Trigger("triage", { event: new EventSelector({ channel: "test", type: "opened" }), agent: triage });
new Trigger("kickoff", { event: new EventSelector({ channel: "test", type: "opened" }), agent: coder });
`;

export const CONFIG_FILES: Record<string, string> = {
  ".achq/config.ts": CONFIG,
  ".achq/lib/settings.ts": `
const deny = ["secrets", "keys"].map((dir) => \`Read(./\${dir}/**)\`);
export const settingsFor = (name: string) => ({ env: { AGENT: name.toUpperCase() }, permissions: { deny } });
`,
  ".achq/prompts/coder.md": "You are the coder.\n",
  ".achq/prompts/triage.md": "You are the triager.\n",
  ".achq/tool.toml": "level = 1\n",
  ".achq/Dockerfile": "FROM oven/bun\n",
};

/** A bare origin with `main` (holding `.achq/`) and `docs`, and a clone to commit from. */
/** A bare repo with `files` on main and `docs` on a `docs` branch, and a way to push more commits. */
export const makeOrigin = async (root: string, files: Record<string, string> = CONFIG_FILES, docs: Record<string, string> = { "docs.txt": "docs branch\n" }) => {
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  await $`git init -q --bare -b main ${origin}`.quiet();
  await $`git init -q -b main ${seed}`.quiet();
  const git = (...args: string[]) => $`git -C ${seed} -c user.name=t -c user.email=t@t ${args}`.quiet();
  const write = (files: Record<string, string>) => {
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
      fs.writeFileSync(path.join(seed, file), content);
    }
  };
  write({ ...files, "README.md": "main\n" });
  await git("add", "-A");
  await git("commit", "-qm", "init");
  await git("checkout", "-qb", "docs");
  write(docs);
  await git("add", "-A");
  await git("commit", "-qm", "docs");
  await git("push", "-q", origin, "main", "docs");
  await git("checkout", "-q", "main");
  const head = async () => (await $`git -C ${seed} rev-parse HEAD`.quiet().text()).trim();
  return {
    origin,
    first: await head(),
    /** Commits on main and pushes; returns the commit and its parent. */
    async commit(files: Record<string, string>, message = "change") {
      const before = await head();
      write(files);
      await git("add", "-A");
      await git("commit", "-qm", message);
      await git("push", "-q", origin, "main");
      return { before, after: await head() };
    },
  };
};

// ─── Fake claude ─────────────────────────────────────────────────────────────

export type ClaudeCall = { argv: string[]; env: Record<string, string>; stdin: string; cwd: string; start: number; end: number };

/**
 * A `claude` that records its argv, env, stdin and cwd to $FAKE_CLAUDE_LOG,
 * writes the session's transcript like Claude Code does, and emits stream-json.
 * $FAKE_CLAUDE_DELAY_MS makes runs take time; $FAKE_CLAUDE_FAIL makes them fail.
 */
export const fakeClaude = (dir: string) => {
  const bin = path.join(dir, "claude");
  const log = path.join(dir, "calls");
  fs.mkdirSync(log, { recursive: true });
  // A shell wrapper, since bun's path may have spaces a shebang can't hold.
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath.replace(/'/g, `'\\''`)}' '${bin}.js' "$@"\n`);
  fs.writeFileSync(
    `${bin}.js`,
    `const fs = require("node:fs");
const argv = process.argv.slice(2);
const stdin = argv.includes("-p") ? await Bun.stdin.text() : "";
const start = Date.now();
await Bun.sleep(Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 0));
const flag = (name) => argv.find((a) => a.startsWith(name + "="))?.slice(name.length + 1);
const id = flag("--session-id") ?? flag("--resume");
const projects = process.env.CLAUDE_CONFIG_DIR + "/projects/-wt";
fs.mkdirSync(projects, { recursive: true });
fs.appendFileSync(projects + "/" + id + ".jsonl", JSON.stringify({ stdin }) + "\\n");
fs.writeFileSync(process.env.FAKE_CLAUDE_LOG + "/" + start + "-" + Math.random().toString(36).slice(2) + ".json",
  JSON.stringify({ argv, env: process.env, stdin, cwd: process.cwd(), start, end: Date.now() }));
const out = (e) => console.log(JSON.stringify(e));
out({ type: "system", subtype: "init", session_id: id });
if (stdin.startsWith("/compact")) out({ type: "system", subtype: "compact_boundary", session_id: id, compact_metadata: { pre_tokens: 150000, post_tokens: 20000 } });
out({ type: "assistant", session_id: id, message: { content: [{ type: "text", text: "working" }], usage: { input_tokens: 10, output_tokens: 5 } } });
if (process.env.FAKE_CLAUDE_FAIL) { console.error("boom: " + process.env.FAKE_CLAUDE_FAIL); process.exit(3); }
out({ type: "result", subtype: "success", is_error: false, session_id: id, num_turns: 1, result: "Reply for " + id, modelUsage: { m: { contextWindow: 200000 } } });
`,
  );
  fs.chmodSync(bin, 0o755);
  const calls = (): ClaudeCall[] =>
    fs
      .readdirSync(log)
      .sort((a, b) => Number(a.split("-")[0]) - Number(b.split("-")[0]))
      .map((f) => JSON.parse(fs.readFileSync(path.join(log, f), "utf8")));
  return { bin, log, calls, flag: (call: ClaudeCall, name: string) => call.argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1) };
};

// ─── Fake router ─────────────────────────────────────────────────────────────

export const CHANNEL_TOKEN = "channel-token-never-for-agents";

export const fakeRouter = (secret: string, opts: { expiresIn?: () => number; now?: () => number } = {}) => {
  const claims: unknown[] = [];
  const rejected: string[] = [];
  let mints = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      if (!verifySigned(secret, req.method, url.pathname, body, req.headers)) {
        rejected.push(url.pathname);
        return new Response("bad signature", { status: 401 });
      }
      if (url.pathname === "/claims") {
        claims.push(JSON.parse(body));
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/credentials") {
        mints++;
        const expiresAt = new Date((opts.now ?? Date.now)() + (opts.expiresIn?.() ?? 60 * 60_000)).toISOString();
        const response: CredentialsResponse = {
          credentials: [{ provider: "test-access", value: `agent-token-${mints}`, expiresAt, scope: {} }],
          channels: [{ provider: "test", value: CHANNEL_TOKEN, expiresAt, scope: { source: "app" } }],
        };
        return Response.json(response);
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://localhost:${server.port}`, claims, rejected, mints: () => mints, stop: () => server.stop(true) };
};

/** Writes each token to `dir/token` (mode 600) and points agents at it. */
export const testAccess = (): AccessProvider => ({
  id: "test-access",
  validate: async () => [],
  mint: async () => [],
  async install(credentials, dir) {
    const file = path.join(dir, "token");
    fs.writeFileSync(file, credentials[0]!.value, { mode: 0o600 });
    return { env: { TEST_TOKEN_FILE: file } };
  },
});

// ─── Test channel ────────────────────────────────────────────────────────────

type TestThread = { title: string; labels: string[]; messages: Message[] };

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
  async mintClient(): Promise<Credential> {
    throw new Error("router only");
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
