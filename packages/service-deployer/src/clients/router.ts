// The router's admin endpoints, for the deployer. Every request is signed with
// adminSecret(AGENT_WEBHOOK_KEY).
import type { InstalledRepo, PolicyCredential, MintRequest, SourceSettings, ValidateRequest, RouterRepoConfig } from "@achq/core";
import { adminSecret } from "@achq/core/secrets";
import { signedFetch } from "@achq/core/signing";
import { HttpError } from "@achq/utils/http";

export interface RouterClient {
  mint(request: MintRequest): Promise<PolicyCredential[]>;
  validate(request: ValidateRequest): Promise<{ problems: string[] }>;
  putRepo(config: RouterRepoConfig): Promise<void>;
  deleteRepo(repo: string): Promise<void>;
  installed(): Promise<InstalledRepo[]>;
  sources(): Promise<SourceSettings[]>;
}

/** Who answers, in a failed call's HttpError: `Router GET /admin/installed: 401 …`. */
const SERVICE = "Router";

const withoutTrailingSlashes = (url: string) => url.replace(/\/+$/, "");

/** A JSON body, or undefined for an empty one, as a 204 has. */
const parseJsonBody = <T>(text: string) => (text ? JSON.parse(text) : undefined) as T;

/** A response that isn't 2xx throws an HttpError. */
const signedJsonClient =
  (secret: string, base: string) =>
  async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await signedFetch(secret, base + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) throw new HttpError(res.status, method, path, await res.text(), SERVICE);
    return parseJsonBody<T>(await res.text());
  };

const parseRepo = (repo: string) => {
  const [owner, name, ...rest] = repo.split("/");
  return owner && name && !rest.length ? { owner, name } : undefined;
};

const repoPath = (repo: string) => {
  const parts = parseRepo(repo);
  if (!parts) throw new Error(`"${repo}" isn't owner/name`);
  return `/admin/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.name)}`;
};

/** `url` is the router's private base URL (ACHQ_ROUTER_URL). */
export const routerClient = ({ url, key }: { url: string; key: string }): RouterClient => {
  const call = signedJsonClient(adminSecret(key), withoutTrailingSlashes(url));
  return {
    mint: (request) => call("POST", "/admin/mint", request),
    validate: (request) => call("POST", "/admin/validate", request),
    putRepo: (config) => call("PUT", repoPath(config.repo), config),
    deleteRepo: (repo) => call("DELETE", repoPath(repo)),
    installed: () => call("GET", "/admin/installed"),
    sources: () => call("GET", "/admin/sources"),
  };
};
