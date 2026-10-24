import * as fs from "node:fs";
import * as path from "node:path";
import { type PolicyCredential, type PolicyData, type PolicyProvider, repoName } from "@achq/core";
import { disk } from "@achq/utils/disk";
import type { z } from "zod";
import type { Permissions } from "@achq/utils/gh";
import { type Apps, botLogin, type FoundInstallation } from "../lib/apps.ts";
import { POLICY_PROVIDER, REPO } from "../lib/constants.ts";
import { GH_CONFIG_DIR, GH_HOSTS_FILE, GIT_CONFIG_FILE, ghHostsYml, gitConfig, removeStaleTokens, tokenFileName, writeSecretFile } from "../lib/git-credentials.ts";
import { covers, maxLevel } from "../lib/permissions.ts";
import { GitHubPolicyData } from "../lib/schemas.ts";

/** gh's config directory is only the agent's. */
const GH_DIR_MODE = 0o700;
const ANONYMOUS_GH_USER = "x-access-token";

/** One token's worth of policies: one App installation, one repo, the highest level asked for of each permission. */
type TokenGroup = { source: string; installation: number; repos: string[]; permissions: Permissions };

const notInstalled = (source: string | undefined, repo: string) =>
  source ? `${source} isn't installed on ${repo}` : `No GitHub App on the router is installed on ${repo}`;

/**
 * What's wrong with a policy's shape, said as validate says it: the first of
 * its provider, source, repo or permission levels that's wrong (each wrong
 * level, for those).
 */
const shapeProblems = (data: PolicyData, repo: string, issues: z.core.$ZodIssue[]) => {
  const at = (key: string) => issues.filter((issue) => issue.path[0] === key);
  if (at("provider").length) return [`Policy is for policy provider "${data.provider}", not github`];
  if (at("source").length) return [`GitHub App "${data.source}" isn't configured on the router`];
  if (at("repo").length) return [`"${data.repo ?? repo}" isn't an owner/name repo`];
  const levels = at("permissions");
  const permissions = data.permissions as Record<string, unknown>;
  if (levels.length) return levels.map(({ path: [, name] }) => (name === undefined ? `Permissions must map each permission to "read" or "write"` : `Permission ${String(name)} is "${permissions[name as string]}"; it must be "read" or "write"`));
  return issues.map((issue) => issue.message);
};

export class GitHubPolicyProvider implements PolicyProvider {
  readonly id = POLICY_PROVIDER;

  constructor(private apps: Apps) {}

  /** The policy's App's installation on the repo's owner, or else whichever App's covers the repo. */
  private async installation(source: string | undefined, repo: string) {
    if (!source) return this.apps.installedOn(repo);
    const installation = await this.apps.installation(source, repo);
    return installation && { slug: source, installation };
  }

  async validate(data: PolicyData, repo: string) {
    const parsed = GitHubPolicyData.safeParse(data);
    if (!parsed.success) return shapeProblems(data, repo, parsed.error.issues);
    const policy = parsed.data;
    if (policy.source !== undefined && !this.apps.has(policy.source)) return [`GitHub App "${policy.source}" isn't configured on the router`];
    const target = policy.repo ?? repo;
    if (!REPO.test(target)) return [`"${target}" isn't an owner/name repo`];
    const permissions = Object.entries(policy.permissions);

    const found = await this.installation(policy.source, target);
    if (!found) return [notInstalled(policy.source, target)];
    const { slug, installation } = found;
    const owner = installation.account.login;
    if (installation.suspended_at) return [`${slug}'s installation on ${owner} is suspended`];
    const ungranted = permissions.filter(([name, level]) => !covers(installation.permissions[name], level));
    if (ungranted.length) {
      return ungranted.map(([name, level]) => {
        const granted = installation.permissions[name];
        return `${slug} has ${granted ? `${name}: ${granted}` : `no ${name} permission`} on ${owner}; the policy wants ${name}: ${level}`;
      });
    }

    const coverage = await this.apps.covers(slug, installation.id, target);
    return coverage.covered ? [] : [`${slug}'s installation on ${owner} doesn't cover ${target}: ${coverage.reason}`];
  }

  /**
   * One token per repo and App, at the highest level its policies ask for.
   * Not one per installation, because a token's permissions apply to all its
   * repos. A repo with `contents: read` would get `write` if it shared a token
   * with one that needs write.
   * The config's own repo comes first, since gh uses the first token.
   */
  async mint(policies: PolicyData[], repo: string): Promise<PolicyCredential[]> {
    // Each source's installation on a repo is looked up once.
    const lookups = new Map<string, Promise<FoundInstallation | undefined>>();
    const groups = new Map<string, TokenGroup>();
    for (const data of policies) {
      if (data.provider !== POLICY_PROVIDER) continue;
      const policy = GitHubPolicyData.parse(data);
      const target = policy.repo ?? repo;
      if (!REPO.test(target)) throw new Error(`"${target}" isn't an owner/name repo`);
      const lookup = `${policy.source ?? ""}\n${repoName.key(target)}`;
      if (!lookups.has(lookup)) lookups.set(lookup, this.installation(policy.source, target));
      const found = await lookups.get(lookup);
      if (!found) throw new Error(notInstalled(policy.source, target));
      const key = `${found.slug}\n${found.installation.id}\n${repoName.key(target)}`;
      const group = groups.get(key) ?? { source: found.slug, installation: found.installation.id, repos: [], permissions: {} };
      groups.set(key, group);
      if (!group.repos.some((r) => repoName.same(r, target))) group.repos.push(target);
      for (const [name, level] of Object.entries(policy.permissions)) group.permissions[name] = maxLevel(group.permissions[name], level);
    }

    const rank = (group: TokenGroup) => (repoName.same(group.repos[0]!, repo) ? 0 : 1);
    const ownRepoFirst = [...groups.values()].sort((a, b) => rank(a) - rank(b));
    return Promise.all(
      ownRepoFirst.map(async ({ source, installation, repos, permissions }) => {
        const token = await this.apps.token(source, installation, { repositories: repos.map((r) => repoName.split(r).name), permissions });
        return { provider: POLICY_PROVIDER, value: token.token, expiresAt: token.expires_at, scope: { source, installation, repos, permissions } };
      }),
    );
  }

  /**
   * Container side, no network. Writes each token to
   * `dir/<source>-<installation>-<repo>.token`, plus gh's `hosts.yml` and a git
   * config with a helper per repo URL. gh has one token per host, so it gets
   * the first credential. Every file is replaced atomically, so a running git
   * or gh never reads a half-written token.
   *
   * The git config is included through `GIT_CONFIG_COUNT`. Setting
   * `GIT_CONFIG_GLOBAL` instead would replace `~/.gitconfig`, losing
   * user.name, user.email and anything the image or startup files set.
   * Env config is read last, so these helpers win over any others.
   * The env is the same on every refresh. Only the files behind it change.
   * A caller that sets its own `GIT_CONFIG_COUNT` must merge, not overwrite.
   */
  async install(credentials: PolicyCredential[], dir: string) {
    const mine = credentials.filter((c) => c.provider === POLICY_PROVIDER);
    const ghDir = path.join(dir, GH_CONFIG_DIR);
    disk.ensureDir(ghDir, { mode: GH_DIR_MODE });

    const tokenFiles = new Set<string>();
    const entries: { repo: string; tokenFile: string }[] = [];
    mine.forEach((credential, i) => {
      const name = tokenFileName(credential, i);
      const tokenFile = path.join(dir, name);
      writeSecretFile(tokenFile, credential.value);
      tokenFiles.add(name);
      const repos = Array.isArray(credential.scope.repos) ? credential.scope.repos : [];
      for (const repo of repos) if (typeof repo === "string" && REPO.test(repo)) entries.push({ repo, tokenFile });
    });

    const gitconfig = path.join(dir, GIT_CONFIG_FILE);
    writeSecretFile(gitconfig, gitConfig(entries));
    // gh is logged in with the first credential, or logged out when there's none.
    const hosts = path.join(ghDir, GH_HOSTS_FILE);
    const [first] = mine;
    if (!first) fs.rmSync(hosts, { force: true });
    else writeSecretFile(hosts, ghHostsYml(first.value, typeof first.scope.source === "string" ? botLogin(first.scope.source) : ANONYMOUS_GH_USER));
    removeStaleTokens(dir, tokenFiles);

    return {
      env: {
        GH_CONFIG_DIR: ghDir,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "include.path",
        GIT_CONFIG_VALUE_0: gitconfig,
      },
    };
  }
}
