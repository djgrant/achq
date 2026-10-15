import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseCommand } from "./command.ts";
import type { Config } from "./config.ts";
import type { GitHub } from "./github.ts";
import { buildPrompt, type Comment, type Issue } from "./prompt.ts";
import { describeHead, ensureWorktree, fetchMirror } from "./repo.ts";
import { readState, writeState } from "./state.ts";
import { footer, StreamStats } from "./stats.ts";
import type { Job } from "./webhook.ts";

const SYSTEM_PROMPT = path.join(import.meta.dir, "..", "system.md");

// Claude only sees the trusted context the runner gives it. These would let it
// read issue content from anyone, so they're denied.
// Reading issues is denied because they can hold anyone's text. Commenting is
// denied because the runner posts Claude's reply.
const DENIED = ["Bash(gh issue view:*)", "Bash(gh issue list:*)", "Bash(gh issue comment:*)", "Bash(gh api:*)", "Bash(gh search:*)"];

// Never handed to Claude: the App key mints tokens for every installation.
const PRIVATE_ENV = ["GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET", "GITHUB_APP_ID"];

/** Runs one issue at a time, and at most `maxRuns` issues at once. */
export class Runner {
  private queues = new Map<number, Promise<void>>();
  private active = 0;
  private waiting: (() => void)[] = [];
  private awake?: Timer;

  constructor(
    private cfg: Config,
    private gh: GitHub,
  ) {}

  enqueue(job: Job) {
    const previous = this.queues.get(job.issue) ?? Promise.resolve();
    const next = previous
      .then(() => this.slot(() => this.run(job)))
      .catch((error) => console.error(`[issue-${job.issue}]`, error));
    this.queues.set(job.issue, next);
  }

  private async slot(fn: () => Promise<void>) {
    if (this.active >= this.cfg.maxRuns) await new Promise<void>((resolve) => this.waiting.push(resolve));
    if (this.active++ === 0) this.stayAwake();
    try {
      await fn();
    } finally {
      if (--this.active === 0) clearInterval(this.awake);
      this.waiting.shift()?.();
    }
  }

  /**
   * Railway sleeps the service after five minutes without outbound traffic, which
   * a long tool call could reach mid-run. A GitHub call every few minutes keeps it
   * awake and refreshes the token Claude's git and gh use before it expires.
   */
  private stayAwake() {
    this.awake = setInterval(
      () => this.gh.api("GET", "/rate_limit").catch((e) => console.error("keep-awake call failed", e)),
      3 * 60_000,
    );
  }

  private async run(job: Job) {
    const { cfg, gh } = this;
    const { paths, repo } = cfg;
    const log = (...args: unknown[]) => console.log(`[issue-${job.issue}]`, ...args);
    const stateFile = paths.state(job.issue);
    const state = readState(stateFile);
    const command = parseCommand(job.body, cfg.trigger);
    const stats = new StreamStats();
    let session = state.session;
    let error: string | undefined;
    let stderr: string[] = [];

    await gh
      .api("POST", `/repos/${repo}/issues/comments/${job.commentId}/reactions`, { content: "eyes" })
      .catch(() => {});

    try {
      if (command.mode === "compact" && !session) throw new Error("There is no session on this issue to compact.");
      const mode = command.mode === "resume" && !session ? "new" : command.mode;
      if (mode !== "new" && !transcriptExists(paths.home, session!)) {
        throw new Error(
          `The transcript for session \`${session}\` is missing from the volume. Comment \`${cfg.trigger} /new <prompt>\` to start a fresh session.`,
        );
      }

      const [{ default_branch }, issue, comments] = await Promise.all([
        gh.api<{ default_branch: string }>("GET", `/repos/${repo}`),
        gh.api<Issue>("GET", `/repos/${repo}/issues/${job.issue}`),
        gh.paginate<Comment>(`/repos/${repo}/issues/${job.issue}/comments`),
      ]);
      await mirrorLock.run(() => fetchMirror(paths.mirror, `https://github.com/${repo}.git`));
      const cwd = paths.worktree(job.issue);
      await ensureWorktree(paths.mirror, cwd, job.issue, default_branch);

      let prompt: string;
      if (mode === "compact") {
        prompt = `/compact ${command.text}`.trim();
      } else {
        const bodySha = createHash("sha256").update(issue.body ?? "").digest("hex");
        const since = mode === "new" ? 0 : state.lastCommentId;
        const built = buildPrompt({
          mode,
          issue,
          comments,
          since,
          bodyChanged: bodySha !== state.bodySha,
          author: job.author,
          bot: gh.bot.login,
          ...(await describeHead(cwd)),
        });
        // An earlier run already picked up this comment along with others.
        if (mode === "resume" && built.included === 0) {
          log("nothing new since the last run; skipping");
          return;
        }
        prompt = built.prompt;
        session = mode === "new" ? randomUUID() : session;
        state.lastCommentId = Math.max(state.lastCommentId, ...comments.map((c) => c.id));
        state.bodySha = bodySha;
      }

      state.session = session;
      state.status = "running";
      writeState(stateFile, state);
      log(`${mode} session ${session}`);

      const args = [
        "-p",
        "--output-format=stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        `--append-system-prompt-file=${SYSTEM_PROMPT}`,
        mode === "new" ? `--session-id=${session}` : `--resume=${session}`,
        "--disallowedTools",
        ...DENIED,
      ];
      const env: Record<string, string | undefined> = { ...process.env, HOME: paths.home, GH_CONFIG_DIR: gh.ghConfigDir, DISABLE_AUTOUPDATER: "1" };
      for (const name of PRIVATE_ENV) delete env[name];

      fs.mkdirSync(path.dirname(paths.lock(job.issue)), { recursive: true });
      // The same lock you take over SSH, so you and the agent never share a session.
      const proc = Bun.spawn(["flock", paths.lock(job.issue), "claude", ...args], {
        cwd,
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      proc.stdin.write(prompt);
      proc.stdin.end();
      const timeout = setTimeout(() => proc.kill(), cfg.runTimeoutMinutes * 60_000);

      const [, errors, exitCode] = await Promise.all([
        eachLine(proc.stdout, (line) => {
          let event: any;
          try {
            event = JSON.parse(line);
          } catch {
            return log(line);
          }
          stats.push(event);
          for (const block of event.type === "assistant" ? (event.message?.content ?? []) : []) {
            if (block.type === "tool_use") log(`→ ${block.name}`, JSON.stringify(block.input).slice(0, 200));
            if (block.type === "text") log(block.text.slice(0, 500));
          }
        }),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(timeout);
      stderr = errors.trim().split("\n").filter(Boolean).slice(-40);
      if (stderr.length) console.error(`[issue-${job.issue}]`, errors);

      if (exitCode !== 0 || stats.result?.is_error) {
        const detail = stats.result?.is_error
          ? `${stats.result.subtype}: ${stats.result.result ?? stats.result.errors?.join("\n") ?? ""}`
          : `claude exited with ${proc.signalCode ?? exitCode}`;
        error = `**The run failed.**\n\n<details><summary>Error output</summary>\n\n\`\`\`\n${[detail, ...stderr].join("\n")}\n\`\`\`\n\n</details>\n\nComment \`${cfg.trigger} <prompt>\` to resume the session, or \`${cfg.trigger} /new <prompt>\` to start over.`;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      console.error(`[issue-${job.issue}]`, e);
    } finally {
      if (state.status === "running") state.status = "idle";
      writeState(stateFile, state);
    }

    await this.report(job.issue, stats, session, command.mode, error).catch((e) =>
      console.error(`[issue-${job.issue}] report failed`, e),
    );
  }

  /** Posts Claude's final reply to the issue, or what went wrong, with the footer. */
  private async report(issue: number, stats: StreamStats, session: string | undefined, mode: string, error: string | undefined) {
    let message: string;
    if (error) message = `⚠️ ${error}`;
    else if (mode === "compact" && stats.compacted)
      message = `Compacted the session: ${tokens(stats.compacted.pre)} → ${tokens(stats.compacted.post)} tokens.`;
    else message = stats.result?.result?.trim() || "Claude finished without a reply.";
    await this.gh.api("POST", `/repos/${this.cfg.repo}/issues/${issue}/comments`, { body: message + footer(stats, session) });
  }
}

/** Marks runs a restart interrupted and says so on their issues. */
export const reportInterrupted = async (cfg: Config, gh: GitHub) => {
  if (!fs.existsSync(cfg.paths.issues)) return;
  for (const file of fs.readdirSync(cfg.paths.issues).filter((f) => f.endsWith(".json"))) {
    const issue = Number(path.basename(file, ".json"));
    const state = readState(cfg.paths.state(issue));
    if (state.status !== "running") continue;
    state.status = "interrupted";
    writeState(cfg.paths.state(issue), state);
    await gh.api("POST", `/repos/${cfg.repo}/issues/${issue}/comments`, {
      body: `⚠️ The agent restarted while this run was in progress. The work so far is in the worktree and the session is intact. Comment \`${cfg.trigger} <prompt>\` to resume it.\n\n<sub>session \`${state.session}\`</sub>\n`,
    });
  }
};

const transcriptExists = (home: string, session: string) => {
  const projects = path.join(home, ".claude", "projects");
  return fs.existsSync(projects) && new Bun.Glob(`*/${session}.jsonl`).scanSync(projects).next().done === false;
};

const tokens = (n: number) => `${Math.floor(n / 1000)}k`;

const eachLine = async (stream: ReadableStream<Uint8Array>, fn: (line: string) => void) => {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) if (line.trim()) fn(line);
  }
  if (buffer.trim()) fn(buffer);
};

/** Serialises operations on the shared mirror. */
const mirrorLock = {
  tail: Promise.resolve() as Promise<unknown>,
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  },
};
