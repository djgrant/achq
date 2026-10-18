import type { ChannelClient, ChannelEvent, Credential, Message, Thread, ThreadRef } from "@achq/core";
import { GitHubClient } from "../api/client.ts";
import { GITHUB_API, TRUSTED } from "../constants.ts";
import { botLogin } from "./bot.ts";
import { labelNames } from "./labels.ts";
import { messageId, OPENING_POST_ID } from "./messages.ts";
import { parseThreadId, slugify } from "./threads.ts";

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
