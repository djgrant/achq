import type { Channel, ChannelClient, ChannelCredential, ChannelEvent, Credential, RepoPlan, SelectorData, ThreadRef } from "@achq/core";
import type { Apps } from "../lib/apps.ts";
import { CHANNEL, REPO } from "../lib/constants.ts";
import type { GitHubUrls } from "../lib/urls.ts";
import { userGitHub } from "../lib/user.ts";
import { appWebhookSecret } from "../lib/webhook-secret.ts";
import { checkApp } from "./app-check.ts";
import { GitHubChannelClient } from "./client.ts";
import { configApp } from "./config-app.ts";
import { CLIENT_PERMISSIONS } from "./constants.ts";
import { parseEvent } from "./events.ts";
import { installRepo, uninstallRepo } from "./install.ts";
import { installations, sources } from "./installations.ts";
import { matchEvent, matchThread } from "./match.ts";
import { verifyGitHubSignature } from "./signature.ts";

/** Apps as channels: each App is a source. The router passes its key; `install` and `uninstall` act as your gh login. */
export class GitHubChannel implements Channel {
  readonly id = CHANNEL;
  private gh;

  constructor(
    private apps: Apps,
    private key: string | undefined,
    urls: GitHubUrls,
  ) {
    this.gh = userGitHub(urls.api);
  }

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
      scope: { source, app: source, installation: installation.id, repos: [repo], permissions: CLIENT_PERMISSIONS },
    };
  }

  installations() {
    return installations(this.apps);
  }

  sources() {
    return sources(this.apps);
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

  async install(repo: string, plan: RepoPlan, { dryRun, open, log }: { dryRun: boolean; open(url: string): Promise<void>; log(line: string): void }) {
    const slug = configApp(plan);
    const check = await checkApp(this.gh, slug, plan);
    if (check.private) log(`${slug} is private, so GitHub won't show its settings; skipping the App check`);
    else if (check.missing.length) throw new Error(`${slug} doesn't have what ${repo}'s config needs: ${check.missing.join(", ")}`);
    else log(`${slug} has the events and permissions the config needs`);
    if (dryRun) return;
    const result = await installRepo(this.gh, slug, repo);
    if (result.kind === "open") {
      log(`${slug} isn't installed on ${repo.split("/")[0]} yet. Install it on ${repo} at ${result.url}`);
      await open(result.url);
    } else if (result.kind === "already") {
      log(`${slug} is already installed on ${repo}${result.all ? " (all repositories)" : ""}`);
    } else {
      log(`Installed ${slug} on ${repo}`);
    }
  }

  async uninstall(repo: string, plan: RepoPlan) {
    const slug = configApp(plan);
    await uninstallRepo(this.gh, slug, repo);
    return `Removed ${repo} from ${slug}. Its containers sleep and are kept until \`achq up --prune\`.`;
  }
}
