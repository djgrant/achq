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

/** `url` is the router's private base URL (ACHQ_ROUTER_URL). */
export const routerClient = ({ url, key }: { url: string; key: string }): RouterClient => {
  const secret = adminSecret(key);
  const base = url.replace(/\/+$/, "");

  /** A response that isn't 2xx throws an HttpError. An empty body, as a 204 has, is undefined. */
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await signedFetch(secret, base + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, method, path, text, SERVICE);
    return (text ? JSON.parse(text) : undefined) as T;
  };

  const repoPath = (repo: string) => {
    const [owner, name, ...rest] = repo.split("/");
    if (!owner || !name || rest.length) throw new Error(`"${repo}" isn't owner/name`);
    return `/admin/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  };

  return {
    mint: (request) => call("POST", "/admin/mint", request),
    validate: (request) => call("POST", "/admin/validate", request),
    putRepo: (config) => call("PUT", repoPath(config.repo), config),
    deleteRepo: (repo) => call("DELETE", repoPath(repo)),
    installed: () => call("GET", "/admin/installed"),
    sources: () => call("GET", "/admin/sources"),
  };
};
