// Outside core's index, which the config sandbox loads without fetch or node:crypto.
import { HttpError } from "@achq/utils/http";
import type { PolicyCredential } from "../contracts/policy-provider.ts";
import type {
  CredentialsRequest,
  CredentialsResponse,
  DeployerVersion,
  DeployRecord,
  FailedDelivery,
  InstalledRepo,
  MintRequest,
  ReplayResult,
  RouterRepoConfig,
  SourceSettings,
  SyncRequest,
  SyncStarted,
  SyncStatus,
  ValidateRequest,
} from "./protocol.ts";
import { adminSecret } from "./secrets.ts";
import { signedFetch } from "./signing.ts";

/**
 * Calls to an achq service at `base`, each signed with `secret`. A response
 * that isn't 2xx throws an HttpError naming `service`, e.g. `Router GET
 * /admin/installed: 401 bad signature`. An empty body, as a 204 has, is undefined.
 */
export const signedClient = ({ secret, base, service }: { secret: string; base: string; service: string }) => {
  const root = base.replace(/\/+$/, "");
  return {
    call: async <T = void>(method: string, path: string, body?: unknown): Promise<T> => {
      const res = await signedFetch(secret, root + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      if (!res.ok) throw new HttpError(res.status, method, path, text, service);
      return (text ? JSON.parse(text) : undefined) as T;
    },
  };
};

const repoPath = (repo: string) => {
  const [owner, name, ...rest] = repo.split("/");
  if (!owner || !name || rest.length) throw new Error(`"${repo}" isn't owner/name`);
  return `/admin/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
};

/** The router's admin endpoints, signed with the key the router and deployer share. `url` is its public or private base URL. */
export const routerAdmin = ({ url, key }: { url: string; key: string }) => {
  const { call } = signedClient({ secret: adminSecret(key), base: url, service: "Router" });
  return {
    mint: (request: MintRequest) => call<PolicyCredential[]>("POST", "/admin/mint", request),
    validate: (request: ValidateRequest) => call<{ problems: string[] }>("POST", "/admin/validate", request),
    putRepo: (config: RouterRepoConfig) => call("PUT", repoPath(config.repo), config),
    deleteRepo: (repo: string) => call("DELETE", repoPath(repo)),
    installed: () => call<InstalledRepo[]>("GET", "/admin/installed"),
    sources: () => call<SourceSettings[]>("GET", "/admin/sources"),
    /** Each repo's deploy, as the deployer recorded it. */
    status: () => call<DeployRecord[]>("GET", "/admin/status"),
    failed: () => call<FailedDelivery[]>("GET", "/admin/failed"),
    replay: () => call<ReplayResult>("POST", "/admin/failed/replay"),
    /** Starts the deployer syncing: it can outlast a request, so `syncStatus` asks after it. */
    sync: (request: SyncRequest) => call<SyncStarted>("POST", "/admin/sync", request),
    syncStatus: (id: string) => call<SyncStatus>("GET", `/admin/sync/${encodeURIComponent(id)}`),
    deployerVersion: () => call<DeployerVersion>("GET", "/admin/deployer"),
  };
};

export type RouterAdmin = ReturnType<typeof routerAdmin>;

/** The router's endpoints for a container, signed with its container secret. */
export const routerForContainer = ({ url, secret }: { url: string; secret: string }) => {
  const { call } = signedClient({ secret, base: url, service: "Router" });
  return {
    credentials: (request: CredentialsRequest) => call<CredentialsResponse>("POST", "/credentials", request),
  };
};
