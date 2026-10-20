// Agents' credentials are installed on the volume by each policy provider. The
// runner's channel credentials are kept in memory only.
import type { ChannelCredential, CredentialsRequest, CredentialsResponse, PolicyProvider } from "@achq/core";
import { signedFetch } from "@achq/core/signing";
import { singleFlight } from "@achq/utils/async";
import { ensureDir } from "@achq/utils/fs";
import { expectOk } from "@achq/utils/http";
import { REFRESH_BEFORE_MS } from "./constants.ts";
import { logFailure } from "./log-failure.ts";
import type { Paths } from "./paths.ts";

export type CredentialsOptions = {
  routerUrl: string;
  containerSecret: string;
  repo: string;
  container: string;
  policyProviders: PolicyProvider[];
  paths: Paths;
  now?: () => number;
  log?: (line: string) => void;
};

export type Current = CredentialsResponse & {
  env: Record<string, string>;
};

export class Credentials {
  private current?: Current;
  private now: () => number;
  private log: (line: string) => void;

  constructor(private opts: CredentialsOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /**
   * Valid credentials. Fetches when there are none or they've expired. When
   * fewer than 30 minutes remain, returns these and refreshes in the background.
   */
  async get(): Promise<Current> {
    const current = this.current;
    const state = freshness(current, this.now());
    if (state === "expired") return this.refresh();
    if (state === "expiring") void logFailure(this.refresh(), this.log, "credential refresh failed");
    return current!;
  }

  /** Never given to agents. */
  async channel(channel: string, source: string): Promise<ChannelCredential> {
    const { channels } = await this.get();
    const found = channels.find((c) => c.channel === channel && c.scope.source === source);
    if (!found) throw new Error(`The router gave no credential for channel ${channel} (${source})`);
    return found;
  }

  private refresh = singleFlight(async (): Promise<Current> => {
    const response = await this.requestCredentials();
    this.current = { ...response, env: await this.installCredentials(response) };
    return this.current;
  });

  private async requestCredentials(): Promise<CredentialsResponse> {
    const { routerUrl, containerSecret, repo, container } = this.opts;
    const request: CredentialsRequest = { repo, container };
    const res = await signedFetch(containerSecret, `${routerUrl}/credentials`, { method: "POST", body: JSON.stringify(request) });
    await expectOk(res, "The router refused credentials");
    return (await res.json()) as CredentialsResponse;
  }

  private async installCredentials(response: CredentialsResponse): Promise<Record<string, string>> {
    const { policyProviders, paths } = this.opts;
    const env: Record<string, string> = {};
    for (const p of policyProviders) {
      const mine = response.credentials.filter((c) => c.provider === p.id);
      if (!mine.length) continue;
      const dir = paths.policyProvider(p.id);
      ensureDir(dir, { mode: PRIVATE_DIR_MODE });
      Object.assign(env, (await p.install(mine, dir)).env);
    }
    const unknown = uninstallable(response, policyProviders);
    if (unknown.length) this.log(`no policy provider installs ${unknown.join(", ")} credentials`);
    return env;
  }
}

/** Only the container's user reads installed credentials. */
const PRIVATE_DIR_MODE = 0o700;

/** `expiring` credentials still work, but are refreshed ahead of time so a failing refresh has time to retry. */
type Freshness = "expired" | "expiring" | "fresh";

const freshness = (current: CredentialsResponse | undefined, now: number): Freshness => {
  if (!current) return "expired";
  const left = expiry(current) - now;
  if (left <= 0) return "expired";
  return left < REFRESH_BEFORE_MS ? "expiring" : "fresh";
};

const expiry = (c: CredentialsResponse) =>
  Math.min(...[...c.credentials, ...c.channels].map((x) => Date.parse(x.expiresAt)), Number.POSITIVE_INFINITY);

const uninstallable = (response: CredentialsResponse, policyProviders: PolicyProvider[]) => {
  const known = new Set(policyProviders.map((p) => p.id));
  return [...new Set(response.credentials.map((c) => c.provider).filter((id) => !known.has(id)))];
};
