import * as fs from "node:fs";
import * as path from "node:path";
import type { PolicyCredential, PolicyData, PolicyProvider } from "@achq/core";
import { ensureDir } from "@achq/utils/fs";
import { type Installation, repoKey, sameRepo, splitRepo } from "@achq/utils/gh";
import type { Apps, FoundInstallation } from "../lib/apps.ts";
import { botLogin } from "../lib/client.ts";
import { POLICY_PROVIDER, REPO } from "../lib/constants.ts";
import {
  GH_CONFIG_DIR,
  GH_HOSTS_FILE,
  GIT_CONFIG_FILE,
  ghHostsYml,
  gitConfig,
  removeStaleTokens,
  tokenFileName,
  writeSecretFile,
} from "../lib/git-credentials.ts";
import { covers, maxLevel, type Permissions, POLICY_LEVELS } from "../lib/permissions.ts";
import type { GitHubPolicyData } from "./resource.ts";

/** gh's config directory is only the agent's. */
const GH_DIR_MODE = 0o700;
const ANONYMOUS_GH_USER = "x-access-token";

/** One token's worth of policies: one App installation, one repo, the highest level asked for of each permission. */
type TokenGroup = { source: string; installation: number; repos: string[]; permissions: Permissions };

const notInstalled = (source: string | undefined, repo: string) =>
  source ? `${source} isn't installed on ${repo}` : `No GitHub App on the router is installed on ${repo}`;

const ownRepoFirst = (repo: string) => {
  const rank = (group: TokenGroup) => (sameRepo(group.repos[0]!, repo) ? 0 : 1);
  return (a: TokenGroup, b: TokenGroup) => rank(a) - rank(b);
};

const badLevels = (permissions: Record<string, string>) =>
  Object.entries(permissions)
    .filter(([, level]) => !POLICY_LEVELS.has(level))
    .map(([name, level]) => `Permission ${name} is "${level}"; it must be "read" or "write"`);

const suspended = (slug: string, installation: Installation) =>
  installation.suspended_at ? [`${slug}'s installation on ${installation.account.login} is suspended`] : [];

const ungranted = (slug: string, installation: Installation, permissions: Record<string, string>) =>
  Object.entries(permissions)
    .filter(([name, level]) => !covers(installation.permissions[name], level))
    .map(([name, level]) => {
      const granted = installation.permissions[name];
      return `${slug} has ${granted ? `${name}: ${granted}` : `no ${name} permission`} on ${installation.account.login}; the policy wants ${name}: ${level}`;
    });

export class GitHubPolicyProvider implements PolicyProvider {
  readonly id = POLICY_PROVIDER;

  constructor(private apps: Apps) {}

  private async installation(source: string | undefined, repo: string): Promise<FoundInstallation | undefined> {
    if (!source) return this.apps.installedOn(repo);
    const installation = await this.apps.installation(source, repo);
    return installation && { slug: source, installation };
  }

  async validate(data: PolicyData, repo: string): Promise<string[]> {
    const policy = data as Partial<GitHubPolicyData>;
    if (policy.provider !== POLICY_PROVIDER) return [`Policy is for policy provider "${policy.provider}", not github`];
    if (policy.source !== undefined && (typeof policy.source !== "string" || !this.apps.has(policy.source))) {
      return [`GitHub App "${policy.source}" isn't configured on the router`];
    }
    const target = policy.repo ?? repo;
    if (typeof target !== "string" || !REPO.test(target)) return [`"${target}" isn't an owner/name repo`];
    const permissions = policy.permissions ?? {};
    const levels = badLevels(permissions);
    if (levels.length) return levels;

    const found = await this.installation(policy.source, target);
    if (!found) return [notInstalled(policy.source, target)];
    const { slug, installation } = found;
    const unusable = suspended(slug, installation);
    if (unusable.length) return unusable;
    const missing = ungranted(slug, installation, permissions);
    if (missing.length) return missing;

    const coverage = await this.apps.covers(slug, installation.id, target);
    return coverage.covered ? [] : [`${slug}'s installation on ${installation.account.login} doesn't cover ${target}: ${coverage.reason}`];
  }

  /**
   * One token per repo and App, at the highest level its policies ask for.
   * Not one per installation, because a token's permissions apply to all its
   * repos. A repo with `contents: read` would get `write` if it shared a token
   * with one that needs write.
   * The config's own repo comes first, since gh uses the first token.
   */
  async mint(policies: PolicyData[], repo: string): Promise<PolicyCredential[]> {
    const groups = await this.groupByTokenScope(policies, repo);
    return Promise.all(groups.sort(ownRepoFirst(repo)).map((group) => this.mintGroup(group)));
  }

  private async groupByTokenScope(policies: PolicyData[], repo: string): Promise<TokenGroup[]> {
    const lookups = new Map<string, Promise<FoundInstallation | undefined>>();
    const findInstallationOnce = (source: string | undefined, target: string) => {
      const key = `${source ?? ""}\n${repoKey(target)}`;
      let found = lookups.get(key);
      if (!found) lookups.set(key, (found = this.installation(source, target)));
      return found;
    };
    const groups = new Map<string, TokenGroup>();
    for (const data of policies) {
      const policy = data as GitHubPolicyData;
      if (policy.provider !== POLICY_PROVIDER) continue;
      const target = policy.repo ?? repo;
      if (!REPO.test(target)) throw new Error(`"${target}" isn't an owner/name repo`);
      const found = await findInstallationOnce(policy.source, target);
      if (!found) throw new Error(notInstalled(policy.source, target));
      const key = `${found.slug}\n${found.installation.id}\n${repoKey(target)}`;
      const group = groups.get(key) ?? { source: found.slug, installation: found.installation.id, repos: [], permissions: {} };
      groups.set(key, group);
      if (!group.repos.some((r) => sameRepo(r, target))) group.repos.push(target);
      for (const [name, level] of Object.entries(policy.permissions)) group.permissions[name] = maxLevel(group.permissions[name], level);
    }
    return [...groups.values()];
  }

  private async mintGroup({ source, installation, repos, permissions }: TokenGroup): Promise<PolicyCredential> {
    const token = await this.apps.token(source, installation, { repositories: repos.map((r) => splitRepo(r).name), permissions });
    return {
      provider: POLICY_PROVIDER,
      value: token.token,
      expiresAt: token.expires_at,
      scope: { source, installation, repos, permissions },
    };
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
  async install(credentials: PolicyCredential[], dir: string): Promise<{ env: Record<string, string> }> {
    const mine = credentials.filter((c) => c.provider === POLICY_PROVIDER);
    const ghDir = path.join(dir, GH_CONFIG_DIR);
    ensureDir(ghDir, { mode: GH_DIR_MODE });

    const tokenFiles = new Set<string>();
    const entries: { repo: string; tokenFile: string }[] = [];
    mine.forEach((credential, i) => {
      const name = tokenFileName(credential, i);
      const tokenFile = path.join(dir, name);
      writeSecretFile(tokenFile, credential.value);
      tokenFiles.add(name);
      for (const repo of credentialRepos(credential)) entries.push({ repo, tokenFile });
    });

    const gitconfig = path.join(dir, GIT_CONFIG_FILE);
    writeSecretFile(gitconfig, gitConfig(entries));
    writeGhHosts(path.join(ghDir, GH_HOSTS_FILE), mine[0]);
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

const credentialRepos = (credential: PolicyCredential): string[] => {
  const repos = Array.isArray(credential.scope.repos) ? credential.scope.repos : [];
  return repos.filter((repo): repo is string => typeof repo === "string" && REPO.test(repo));
};

/** Logs gh in with `credential`, or logs it out when there's none. */
const writeGhHosts = (hosts: string, credential: PolicyCredential | undefined) => {
  if (!credential) return fs.rmSync(hosts, { force: true });
  const { source } = credential.scope;
  writeSecretFile(hosts, ghHostsYml(credential.value, typeof source === "string" ? botLogin(source) : ANONYMOUS_GH_USER));
};
