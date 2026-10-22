import type { PolicyCredential } from "@achq/core";
import { adminSecret } from "@achq/core/secrets";
import { signedFetch } from "@achq/core/signing";
import { http } from "@achq/utils/http";
import type { RepoConnection } from "@achq/utils/cloudflare";

/** A repo as Workers Builds connects to it: by GitHub's ids for it and its owner. */
export type RepoIds = (repo: string) => Promise<RepoConnection>;

const GITHUB_API = "https://api.github.com";

/**
 * Asks GitHub for a repo's ids, with a token the router mints through
 * whichever of its Apps is installed on the repo: the deployer holds no GitHub
 * token of its own, and a private repo's ids are only shown to one that can see it.
 */
export const routerRepoIds =
  ({ routerUrl, key, githubApi = GITHUB_API }: { routerUrl: string; key: string; githubApi?: string }): RepoIds =>
  async (repo) => {
    const body = JSON.stringify({ repo, policies: [{ provider: "github", repo, permissions: { metadata: "read" } }] });
    const minted = await signedFetch(adminSecret(key), `${routerUrl.replace(/\/+$/, "")}/admin/mint`, { method: "POST", body });
    await http.expectOk(minted, `The router couldn't mint a token to read ${repo}`);
    const token = ((await minted.json()) as PolicyCredential[]).find((c) => c.provider === "github")?.value;
    if (!token) throw new Error(`The router minted no GitHub token for ${repo}`);
    const res = await http.expectOk(await fetch(`${githubApi}/repos/${repo}`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } }), `GitHub couldn't show ${repo}`);
    const found = (await res.json()) as { id: number; name: string; owner: { id: number; login: string } };
    return { provider_type: "github", provider_account_id: String(found.owner.id), provider_account_name: found.owner.login, repo_id: String(found.id), repo_name: found.name };
  };
