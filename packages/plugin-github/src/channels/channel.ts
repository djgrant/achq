import type { Channel, ChannelClient, ChannelCredential, ChannelEvent, Credential, RepoPlan, SelectorData, ThreadRef } from "@achq/core";
import type { Apps } from "../lib/apps.ts";
import { CHANNEL, REPO } from "../lib/constants.ts";
import { appWebhookSecret } from "../lib/webhook-secret.ts";
import { AppInstallation } from "../resources/app-installation.ts";
import { GitHubChannelClient } from "./client.ts";
import { configApp, configNeeds } from "./config-app.ts";
import { CLIENT_PERMISSIONS } from "./constants.ts";
import { parseEvent } from "./events.ts";
import { installations, sources } from "./installations.ts";
import { matchEvent, matchThread } from "./match.ts";
import { verifyGitHubSignature } from "./signature.ts";

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

  /** The config's one App on the repo. */
  installation(repo: string, plan: RepoPlan, installed: boolean) {
    const slug = configApp(plan);
    return [new AppInstallation({ slug, repo, installed, needs: configNeeds(plan, slug) })];
  }
}
