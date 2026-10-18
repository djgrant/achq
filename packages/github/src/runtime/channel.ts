import type { Channel, ChannelClient, ChannelEvent, Credential, SelectorData, ThreadRef } from "@achq/core";
import { appWebhookSecret } from "@achq/core/secrets";
import { CHANNEL, CLIENT_PERMISSIONS, REPO } from "../constants.ts";
import type { Apps } from "./apps.ts";
import { GitHubChannelClient } from "./client.ts";
import { parseEvent } from "./events.ts";
import { matchEvent, matchThread } from "./match.ts";
import { verifyGitHubSignature } from "./signature.ts";

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
