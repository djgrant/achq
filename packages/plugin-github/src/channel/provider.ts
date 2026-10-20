import type { ChannelProvider, ChannelClient, ChannelCredential, ChannelEvent, Credential, Message, SelectorData, SourceSettings, Thread, ThreadRef } from "@achq/core";
import { type GitHub, type Issue, type IssueComment, type ReactionContent, type ReactionTarget, splitRepo, type User } from "@achq/utils/gh";
import { type Apps, appWebhookSecret } from "../lib/apps.ts";
import { asToken, botLogin } from "../lib/client.ts";
import { CHANNEL, GITHUB_API, REPO } from "../lib/constants.ts";
import { CLIENT_PERMISSIONS } from "../lib/permissions.ts";
import { matchEvent, matchThread } from "../lib/selectors.ts";
import { labelNames, messageId, OPENING_POST_ID, parseThreadId, slugify, TRUSTED } from "../lib/threads.ts";
import { parseEvent, verifyGitHubSignature } from "../lib/webhooks.ts";

/** Apps as channels: each App is a source. Only the router has the key that verifies webhooks. */
export class GitHubChannelProvider implements ChannelProvider {
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
    const token = await this.apps.token(source, installation.id, { repositories: [splitRepo(repo).name], permissions: CLIENT_PERMISSIONS });
    return {
      channel: CHANNEL,
      value: token.token,
      expiresAt: token.expires_at,
      scope: { source, installation: installation.id, repos: [repo], permissions: CLIENT_PERMISSIONS },
    };
  }

  sources(): Promise<SourceSettings[]> {
    return Promise.all(
      this.apps.slugs().map(async (slug) => {
        const { events, permissions } = await this.apps.asApp(slug).app();
        return { channel: CHANNEL, source: slug, events, permissions };
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

/** A user's GitHub-provided address, which commits can be attributed to without exposing a real one. */
const noreplyEmail = (user: User) => `${user.id}+${user.login}@users.noreply.github.com`;

/** Message IDs sort chronologically as strings. */
const byId = (a: Message, b: Message) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The runner's view of a repo's issues, with a channel credential from `mintClient`. */
export class GitHubChannelClient implements ChannelClient {
  private gh: GitHub;
  private bot: string;

  constructor(credential: Credential, baseUrl = GITHUB_API) {
    this.gh = asToken(credential.value, baseUrl);
    const source = credential.scope.source;
    if (typeof source !== "string") throw new Error("GitHub credential has no source in its scope");
    this.bot = botLogin(source);
  }

  private issueOf(ref: ThreadRef) {
    const thread = parseThreadId(ref.id);
    return { thread, repo: this.gh.repo(thread.full) };
  }

  async thread(ref: ThreadRef): Promise<Thread> {
    const { thread, repo } = this.issueOf(ref);
    const issue = await repo.issue(thread.number);
    return {
      ref,
      title: issue.title,
      url: issue.html_url,
      labels: labelNames(issue.labels),
      vars: { number: String(issue.number), title: slugify(issue.title ?? ""), owner: thread.owner, repo: thread.repo },
    };
  }

  private toMessage(id: string, post: Issue | IssueComment): Message {
    return {
      id,
      author: post.user?.login ?? "",
      trusted: TRUSTED.has(post.author_association),
      own: post.user?.login === this.bot,
      body: post.body ?? "",
      at: post.created_at,
    };
  }

  async messages(ref: ThreadRef): Promise<Message[]> {
    const { thread, repo } = this.issueOf(ref);
    const [issue, comments] = await Promise.all([repo.issue(thread.number), repo.issueComments(thread.number)]);
    // `edited` isn't set. REST doesn't say when an issue body last changed, and `updated_at` moves with every comment.
    const opening = this.toMessage(OPENING_POST_ID, issue);
    return [opening, ...comments.map((comment) => this.toMessage(messageId(comment.id), comment))].sort(byId);
  }

  async reply(ref: ThreadRef, body: string) {
    const { thread, repo } = this.issueOf(ref);
    await repo.comment(thread.number, body);
  }

  async acknowledge(event: ChannelEvent) {
    if (!event.repo) return;
    const target = reactionTarget(event);
    if (target) await this.gh.repo(event.repo).react(target, ACKNOWLEDGEMENT);
  }

  async identity() {
    const user = await this.gh.user(this.bot);
    return { name: user.login, email: noreplyEmail(user) };
  }
}

const ACKNOWLEDGEMENT: ReactionContent = "eyes";

const reactionTarget = ({ detail: { comment, issue } }: ChannelEvent): ReactionTarget | undefined =>
  typeof comment === "number" ? { comment } : typeof issue === "number" ? { issue } : undefined;
