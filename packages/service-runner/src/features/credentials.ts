import type { ChannelCredential, PolicyProvider } from "@achq/core";
import type { CredentialsResponse } from "@achq/core/protocol";
import { routerForContainer } from "@achq/core/clients/router";
import { async } from "@achq/utils/async";
import { disk } from "@achq/utils/disk";
import { errors } from "@achq/utils/errors";
import { time } from "@achq/utils/time";
import type { Paths } from "./layout.ts";

/** Refresh when this little is left, so a failing refresh has half an hour of retries before anything breaks. */
const REFRESH_BEFORE_MS = 30 * time.MINUTE_MS;

/** Only the container's user reads installed credentials. */
const PRIVATE_DIR_MODE = 0o700;

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
  private router: ReturnType<typeof routerForContainer>;
  private now: () => number;
  private log: (line: string) => void;

  constructor(private opts: CredentialsOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.router = routerForContainer({ url: opts.routerUrl, secret: opts.containerSecret });
  }

  /**
   * Valid credentials. Fetches when there are none or they've expired. When
   * fewer than 30 minutes remain, returns these and refreshes in the background.
   */
  async get() {
    const current = this.current;
    if (!current) return this.refresh();
    const expiry = Math.min(...[...current.credentials, ...current.channels].map((c) => Date.parse(c.expiresAt)), Number.POSITIVE_INFINITY);
    const left = expiry - this.now();
    if (left <= 0) return this.refresh();
    // Expiring credentials still work, but are refreshed ahead of time so a failing refresh has time to retry.
    if (left < REFRESH_BEFORE_MS) void this.refresh().catch((e) => this.log(`credential refresh failed: ${errors.message(e)}`));
    return current;
  }

  /** Never given to agents. */
  async channel(channel: string, source: string): Promise<ChannelCredential> {
    const { channels } = await this.get();
    const found = channels.find((c) => c.channel === channel && c.scope.source === source);
    if (!found) throw new Error(`The router gave no credential for channel ${channel} (${source})`);
    return found;
  }

  private refresh = async.singleFlight(async () => {
    const { repo, container, policyProviders, paths } = this.opts;
    const response = await this.router.credentials({ body: { repo, container } });

    const env: Record<string, string> = {};
    for (const provider of policyProviders) {
      const mine = response.credentials.filter((c) => c.provider === provider.id);
      if (!mine.length) continue;
      const dir = paths.policyProvider(provider.id);
      disk.ensureDir(dir, { mode: PRIVATE_DIR_MODE });
      Object.assign(env, (await provider.install(mine, dir)).env);
    }
    const known = new Set(policyProviders.map((p) => p.id));
    const unknown = [...new Set(response.credentials.map((c) => c.provider).filter((id) => !known.has(id)))];
    if (unknown.length) this.log(`no policy provider installs ${unknown.join(", ")} credentials`);

    this.current = { ...response, env };
    return this.current;
  });
}
