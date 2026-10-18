// The container's credentials, from the router: for agents (installed on the
// volume by each provider) and for the runner's channel clients (memory only).
import * as fs from "node:fs";
import type { CredentialsRequest, CredentialsResponse } from "../core/protocol.ts";
import { signedFetch } from "../core/secrets.ts";
import type { AccessProvider, Credential } from "../core/types.ts";
import type { Paths } from "./paths.ts";

/** Refresh when this little is left, so a failing refresh has half an hour of retries before anything breaks. */
export const REFRESH_BEFORE_MS = 30 * 60_000;

export type CredentialsOptions = {
  routerUrl: string;
  containerSecret: string;
  repo: string;
  container: string;
  providers: AccessProvider[];
  paths: Paths;
  now?: () => number;
  log?: (line: string) => void;
};

export type Current = CredentialsResponse & {
  /** The env agents need for the installed credentials. */
  env: Record<string, string>;
};

export class Credentials {
  private current?: Current;
  private refreshing?: Promise<Current>;
  private now: () => number;

  constructor(private opts: CredentialsOptions) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Valid credentials. Fetches when there are none or they've expired; when
   * fewer than 30 minutes remain, returns these and refreshes in the background.
   */
  async get(): Promise<Current> {
    const current = this.current;
    const left = current ? expiry(current) - this.now() : -1;
    if (!current || left <= 0) return this.refresh();
    if (left < REFRESH_BEFORE_MS) this.refresh().catch((e) => this.opts.log?.(`credential refresh failed: ${e}`));
    return current;
  }

  /** The channel credential for a source, for the runner's ChannelClient. Never given to agents. */
  async channel(channel: string, source: string): Promise<Credential> {
    const { channels } = await this.get();
    const mine = channels.filter((c) => c.provider === channel);
    const found = mine.find((c) => c.scope.source === source || c.scope.app === source) ?? mine[0];
    if (!found) throw new Error(`The router gave no credential for channel ${channel} (${source})`);
    return found;
  }

  private refresh(): Promise<Current> {
    this.refreshing ??= this.fetch().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async fetch(): Promise<Current> {
    const { routerUrl, containerSecret, repo, container, providers, paths } = this.opts;
    const request: CredentialsRequest = { repo, container };
    const res = await signedFetch(containerSecret, `${routerUrl}/credentials`, { method: "POST", body: JSON.stringify(request) });
    if (!res.ok) throw new Error(`The router refused credentials: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const response = (await res.json()) as CredentialsResponse;

    const env: Record<string, string> = {};
    for (const provider of providers) {
      const mine = response.credentials.filter((c) => c.provider === provider.id);
      if (!mine.length) continue;
      const dir = paths.provider(provider.id);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      Object.assign(env, (await provider.install(mine, dir)).env);
    }
    const unknown = response.credentials.filter((c) => !providers.some((p) => p.id === c.provider));
    if (unknown.length) this.opts.log?.(`no provider installs ${[...new Set(unknown.map((c) => c.provider))].join(", ")} credentials`);

    this.current = { ...response, env };
    return this.current;
  }
}

/** When the first credential runs out. */
const expiry = (c: CredentialsResponse) =>
  Math.min(...[...c.credentials, ...c.channels].map((x) => Date.parse(x.expiresAt)), Number.POSITIVE_INFINITY);
