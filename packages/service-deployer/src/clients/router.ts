// Every request is signed with adminSecret(AGENT_WEBHOOK_KEY).
import type { AccessCredential, Installation, MintRequest, SourceSettings, ValidateRequest, RouterRepoConfig } from "@achq/core";
import { adminSecret } from "@achq/core/secrets";
import { signedFetch } from "@achq/core/signing";

export interface RouterClient {
  mint(request: MintRequest): Promise<AccessCredential[]>;
  validate(request: ValidateRequest): Promise<{ problems: string[] }>;
  putRepo(config: RouterRepoConfig): Promise<void>;
  deleteRepo(repo: string): Promise<void>;
  repos(): Promise<RouterRepoConfig[]>;
  installations(): Promise<Installation[]>;
  sources(): Promise<SourceSettings[]>;
}

export class RouterError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    body: string,
  ) {
    super(`Router ${method} ${path}: ${status} ${body.slice(0, 500)}`);
  }
}

/** `url` is the router's private base URL (ACHQ_ROUTER_URL). */
export const routerClient = ({ url, key }: { url: string; key: string }): RouterClient => {
  const secret = adminSecret(key);
  const base = url.replace(/\/+$/, "");
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await signedFetch(secret, base + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) throw new RouterError(res.status, method, path, await res.text());
    if (res.status === 204) return undefined as T;
    const text = await res.text();
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
    repos: () => call("GET", "/admin/repos"),
    installations: () => call("GET", "/admin/installations"),
    sources: () => call("GET", "/admin/sources"),
  };
};
