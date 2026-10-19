import type { Channel, ChannelClient, ChannelCredential, ChannelEvent, Credential, Message, SelectorData, SourceSettings, Thread, ThreadRef } from "@achq/core";
import { type Apps, appWebhookSecret } from "../lib/apps.ts";
import { botLogin, GitHubClient } from "../lib/client.ts";
import { CHANNEL, GITHUB_API, REPO } from "../lib/constants.ts";
import { CLIENT_PERMISSIONS } from "../lib/permissions.ts";
import { matchEvent, matchThread } from "../lib/selectors.ts";
import { labelNames, messageId, OPENING_POST_ID, parseThreadId, slugify, TRUSTED } from "../lib/threads.ts";
import { parseEvent, verifyGitHubSignature } from "../lib/webhooks.ts";

/** Apps as channels: each App is a source. Only the router has the key that verifies webhooks. */
export class GitHubChannel implements Channel {
  readonly id = CHANNEL;

  constructor(
    private apps: Apps,
    private key: string | undefined,
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

  async mintClient(source: string, repo: string): Promise<ChannelCredential> {
    if (!REPO.test(repo)) throw new Error(`Not a repo: ${repo}`);
    const installation = await this.apps.installation(source, repo);
    if (!installation) throw new Error(`${source} isn't installed on ${repo}`);
    const token = await this.apps.token(source, installation.id, { repositories: [repo.split("/")[1]!], permissions: CLIENT_PERMISSIONS });
    return {
      channel: CHANNEL,
      value: token.token,
      expiresAt: token.expires_at,
      scope: { source, installation: installation.id, repos: [repo], permissions: CLIENT_PERMISSIONS },
    };
  }

  /** What each App is set up to send and allow, read as the App. */
  sources(): Promise<SourceSettings[]> {
    return Promise.all(
      this.apps.slugs().map(async (slug) => {
        const app = await this.apps.asApp(slug).request<{ events?: string[]; permissions?: Record<string, string> }>("GET", "/app");
        return { channel: CHANNEL, source: slug, events: app.events ?? [], permissions: app.permissions ?? {} };
      }),
    );
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

/** The runner's view of a repo's issues, with a channel credential from `mintClient`. */
export class GitHubChannelClient implements ChannelClient {
  private api: GitHubClient;
  private bot: string;

  constructor(credential: Credential, baseUrl = GITHUB_API) {
    this.api = new GitHubClient(`token ${credential.value}`, baseUrl);
    const source = credential.scope.source;
    if (typeof source !== "string") throw new Error("GitHub credential has no source in its scope");
    this.bot = botLogin(source);
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
