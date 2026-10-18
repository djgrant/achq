import type { Data, SelectorData, Channel, ChannelClient, ChannelEvent, Credential, Message, Thread, ThreadRef } from "@achq/core";
import { appWebhookSecret, verifyGitHubSignature } from "@achq/core/secrets";
import { GITHUB_API, GitHubClient } from "../api.ts";
import { Apps, REPO, type Permissions } from "./apps.ts";
import { CHANNEL, type EventSelectorData, type IssueSelectorData } from "../resources.ts";

/** Author associations that mean write access to the repo. */
export const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** What the runner's channel credential can do: read the repo, and comment and react on issues. */
export const CLIENT_PERMISSIONS: Permissions = { issues: "write", contents: "read", metadata: "read" };

/**
 * A webhook `push` payload's `commits` array "includes a maximum of 2048
 * commits" (https://docs.github.com/en/webhooks/webhook-events-and-payloads#push).
 * A push listing that many may have dropped some, so it can't tell us whether
 * `.achq/` changed. The limit of 20 is the Events API's, not webhooks'.
 */
export const PUSH_COMMIT_CAP = 2048;

export const CONFIG_DIR = ".achq/";

export const issueThreadId = (repo: string, number: number) => `${repo}#${number}`;

export const parseThreadId = (id: string) => {
  const m = /^([^/#]+)\/([^/#]+)#(\d+)$/.exec(id);
  if (!m) throw new Error(`Not a GitHub issue thread: ${id}`);
  return { owner: m[1]!, repo: m[2]!, full: `${m[1]}/${m[2]}`, number: Number(m[3]) };
};

/** For `{title}` in branch templates: lowercase words joined by dashes, at most 40 characters. */
export const slugify = (title: string, max = 40) =>
  title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");

/**
 * Message IDs must sort chronologically as strings, because the container keeps
 * `id > lastSeen`. GitHub's comment IDs grow over time, so they're zero-padded
 * to 20 digits, enough for any 64-bit ID. The opening post is all zeros, so it
 * sorts before every comment.
 */
export const messageId = (commentId: number | null) => String(commentId ?? 0).padStart(20, "0");
export const OPENING_POST_ID = messageId(null);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether `text` mentions `mention` as GitHub would: case-insensitively, and
 * not as part of a longer name or address (`@claudette`, `me@claude.ai`).
 */
export const mentions = (text: string | undefined, mention: string) =>
  text !== undefined && new RegExp(`(?<![\\w@.-])${escape(mention)}(?![\\w-])`, "i").test(text);

const labelNames = (labels: unknown): string[] =>
  Array.isArray(labels) ? labels.map((l) => (typeof l === "string" ? l : l?.name)).filter((n): n is string => typeof n === "string") : [];

const ISSUE_ACTIONS = new Set(["opened", "edited", "reopened", "labeled"]);
const COMMENT_ACTIONS = new Set(["created", "edited"]);
const INSTALLATION_ACTIONS = new Set(["created", "deleted", "suspend", "unsuspend"]);
const INSTALLATION_REPOS_ACTIONS = new Set(["added", "removed"]);

const fullNames = (repos: unknown): string[] =>
  Array.isArray(repos) ? repos.map((r) => r?.full_name).filter((n): n is string => typeof n === "string") : [];

/**
 * Normalises a verified delivery. Never carries the raw payload: only what the
 * router filters on and the container needs later.
 */
export const parseEvent = (source: string, headers: Headers, body: string): ChannelEvent | undefined => {
  const name = headers.get("x-github-event");
  const delivery = headers.get("x-github-delivery");
  if (!name || !delivery) return undefined;
  let p: any;
  try {
    p = JSON.parse(body);
  } catch {
    return undefined;
  }
  const base = { channel: CHANNEL, source, delivery };
  const repo: string | undefined = p.repository?.full_name;

  if (name === "issues" || name === "issue_comment") {
    const issue = p.issue;
    if (!repo || !issue || issue.pull_request) return undefined;
    if (!(name === "issues" ? ISSUE_ACTIONS : COMMENT_ACTIONS).has(p.action)) return undefined;
    const comment = name === "issue_comment" ? p.comment : undefined;
    if (name === "issue_comment" && !comment) return undefined;
    const author = comment ?? issue;
    const text: string = author.body ?? "";
    const detail: { [key: string]: Data } = { issue: issue.number };
    if (comment) detail.comment = comment.id;
    if (p.action === "labeled" && p.label?.name) detail.label = p.label.name;
    return {
      ...base,
      type: `${name}.${p.action}`,
      repo,
      thread: { channel: CHANNEL, id: issueThreadId(repo, issue.number) },
      labels: labelNames(issue.labels),
      actor: {
        login: author.user?.login ?? "",
        // Content is only trusted when both the issue and the comment come from people with write access.
        trusted: TRUSTED.has(author.author_association) && TRUSTED.has(issue.author_association),
        bot: author.user?.type === "Bot",
      },
      text,
      // An edit that didn't touch the body (e.g. a title change) has no `changes.body`: the text before is the text now.
      ...(p.action === "edited" && { previousText: typeof p.changes?.body?.from === "string" ? p.changes.body.from : text }),
      message: comment ? messageId(comment.id) : OPENING_POST_ID,
      detail,
    };
  }

  if (name === "push") {
    if (!repo) return undefined;
    const commits: any[] = Array.isArray(p.commits) ? p.commits : [];
    const touchesConfig = commits.some((c) =>
      [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])].some((f: string) => f.startsWith(CONFIG_DIR)),
    );
    return {
      ...base,
      type: "push",
      repo,
      detail: {
        ref: p.ref ?? "",
        defaultBranch: p.repository?.default_branch ?? "",
        after: p.after ?? "",
        deleted: Boolean(p.deleted),
        touchesConfig,
        truncated: commits.length >= PUSH_COMMIT_CAP,
      },
    };
  }

  if (name === "installation" || name === "installation_repositories") {
    const actions = name === "installation" ? INSTALLATION_ACTIONS : INSTALLATION_REPOS_ACTIONS;
    if (!actions.has(p.action)) return undefined;
    const added = name === "installation" ? (p.action === "created" ? fullNames(p.repositories) : []) : fullNames(p.repositories_added);
    const removed = name === "installation" ? (p.action === "deleted" ? fullNames(p.repositories) : []) : fullNames(p.repositories_removed);
    return {
      ...base,
      type: `${name}.${p.action}`,
      detail: {
        installation: p.installation?.id ?? 0,
        account: p.installation?.account?.login ?? "",
        // For suspend and unsuspend, the repos the installation covers (when GitHub lists them).
        repos: fullNames(p.repositories),
        added,
        removed,
      },
    };
  }
  return undefined;
};

export const matchEvent = (selector: SelectorData, event: ChannelEvent): boolean => {
  const s = selector as Partial<EventSelectorData>;
  if (s.channel !== CHANNEL || event.channel !== CHANNEL || s.source !== event.source) return false;
  if (typeof s.event !== "string" || !Array.isArray(s.actions)) return false;
  const [name, action] = event.type.split(".");
  if (name !== s.event || !action || !s.actions.includes(action)) return false;
  if (!event.actor || event.actor.bot || !event.actor.trusted) return false;
  if (s.labels?.some((l) => !event.labels?.includes(l))) return false;
  if (s.mention) {
    if (!mentions(event.text, s.mention)) return false;
    // A mention only counts if it wasn't in the text before the edit.
    if (action === "edited" && (event.previousText === undefined || mentions(event.previousText, s.mention))) return false;
  }
  return true;
};

export const matchThread = (selector: SelectorData, thread: { ref: ThreadRef; labels: string[] }): boolean => {
  const s = selector as Partial<IssueSelectorData>;
  if (s.channel !== CHANNEL || thread.ref.channel !== CHANNEL || s.kind !== "issue") return false;
  return (s.labels ?? []).every((l) => thread.labels.includes(l));
};

/** The bot user an App comments as. */
export const botLogin = (slug: string) => `${slug}[bot]`;

/** The runner's view of a repo's issues, with a channel credential from `mintClient`. */
export class GitHubChannelClient implements ChannelClient {
  private api: GitHubClient;
  private bot: string;

  constructor(credential: Credential, baseUrl = GITHUB_API) {
    this.api = new GitHubClient(`token ${credential.value}`, baseUrl);
    const app = credential.scope.app;
    if (typeof app !== "string") throw new Error("GitHub credential has no app in its scope");
    this.bot = botLogin(app);
  }

  private issue(ref: ThreadRef) {
    const t = parseThreadId(ref.id);
    return { ...t, route: `/repos/${t.full}/issues/${t.number}` };
  }

  async thread(ref: ThreadRef): Promise<Thread> {
    const t = this.issue(ref);
    const issue = await this.api.request<any>("GET", t.route);
    return {
      ref,
      title: issue.title,
      url: issue.html_url,
      labels: labelNames(issue.labels),
      vars: { number: String(issue.number), title: slugify(issue.title ?? ""), owner: t.owner, repo: t.repo },
    };
  }

  async messages(ref: ThreadRef): Promise<Message[]> {
    const t = this.issue(ref);
    const [issue, comments] = await Promise.all([
      this.api.request<any>("GET", t.route),
      this.api.paginate<any>(`${t.route}/comments`),
    ]);
    const message = (id: string, c: any): Message => ({
      id,
      author: c.user?.login ?? "",
      trusted: TRUSTED.has(c.author_association),
      own: c.user?.login === this.bot,
      body: c.body ?? "",
      at: c.created_at,
    });
    // `edited` isn't set. REST doesn't say when an issue body last changed, and `updated_at` moves with every comment.
    return [message(OPENING_POST_ID, issue), ...comments.map((c) => message(messageId(c.id), c))].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
  }

  async reply(ref: ThreadRef, body: string) {
    await this.api.request("POST", `${this.issue(ref).route}/comments`, { body });
  }

  async acknowledge(event: ChannelEvent) {
    if (!event.repo) return;
    const { comment, issue } = event.detail;
    const route =
      typeof comment === "number"
        ? `/repos/${event.repo}/issues/comments/${comment}/reactions`
        : typeof issue === "number"
          ? `/repos/${event.repo}/issues/${issue}/reactions`
          : undefined;
    if (route) await this.api.request("POST", route, { content: "eyes" });
  }

  async identity() {
    const user = await this.api.request<{ id: number; login: string }>("GET", `/users/${encodeURIComponent(this.bot)}`);
    return { name: user.login, email: `${user.id}+${user.login}@users.noreply.github.com` };
  }
}

export class GitHubChannel implements Channel {
  readonly id = CHANNEL;

  constructor(
    private apps: Apps,
    private key?: string,
  ) {}

  async verify(headers: Headers, body: string) {
    const appId = headers.get("x-github-hook-installation-target-id");
    if (!this.key || !appId) return undefined;
    const slug = this.apps.byId(appId);
    if (!slug) return undefined;
    return verifyGitHubSignature(appWebhookSecret(this.key, appId), body, headers.get("x-hub-signature-256")) ? slug : undefined;
  }

  parse(source: string, headers: Headers, body: string) {
    return parseEvent(source, headers, body);
  }

  async mintClient(source: string, repo: string): Promise<Credential> {
    if (!REPO.test(repo)) throw new Error(`Not a repo: ${repo}`);
    const installation = await this.apps.installation(source, repo);
    if (!installation) throw new Error(`${source} isn't installed on ${repo}`);
    const token = await this.apps.token(source, installation.id, { repositories: [repo.split("/")[1]!], permissions: CLIENT_PERMISSIONS });
    return {
      provider: CHANNEL,
      value: token.token,
      expiresAt: token.expires_at,
      scope: { app: source, installation: installation.id, repos: [repo], permissions: CLIENT_PERMISSIONS },
    };
  }

  matchEvent(selector: SelectorData, event: ChannelEvent) {
    return matchEvent(selector, event);
  }

  matchThread(selector: SelectorData, thread: { ref: ThreadRef; labels: string[] }) {
    return matchThread(selector, thread);
  }

  client(credential: Credential): ChannelClient {
    return new GitHubChannelClient(credential, this.apps.baseUrl);
  }
}
