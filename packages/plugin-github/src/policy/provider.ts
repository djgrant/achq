import * as fs from "node:fs";
import * as path from "node:path";
import type { PolicyCredential, PolicyData, PolicyProvider } from "@achq/core";
import type { Apps, InstallationInfo } from "../lib/apps.ts";
import { botLogin } from "../lib/client.ts";
import { POLICY_PROVIDER, REPO } from "../lib/constants.ts";
import { GH_CONFIG_DIR, GH_HOSTS_FILE, GIT_CONFIG_FILE, gitConfig, TOKEN_SUFFIX, tokenFileName, writeAtomic } from "../lib/git-credentials.ts";
import { covers, maxLevel, type Permissions, POLICY_LEVELS } from "../lib/permissions.ts";
import type { GitHubPolicyData } from "./resource.ts";

export class GitHubPolicyProvider implements PolicyProvider {
  readonly id = POLICY_PROVIDER;

  constructor(private apps: Apps) {}

  /** The policy's App and its installation on `repo`: the one it names, or else whichever is installed there. */
  private async installation(source: string | undefined, repo: string) {
    if (!source) return this.apps.installedOn(repo);
    const installation = await this.apps.installation(source, repo);
    return installation && { slug: source, installation };
  }

  async validate(policy: PolicyData, repo: string): Promise<string[]> {
    const p = policy as Partial<GitHubPolicyData>;
    if (p.provider !== POLICY_PROVIDER) return [`Policy is for policy provider "${p.provider}", not github`];
    if (p.source !== undefined && (typeof p.source !== "string" || !this.apps.has(p.source))) return [`GitHub App "${p.source}" isn't configured on the router`];
    const target = p.repo ?? repo;
    if (typeof target !== "string" || !REPO.test(target)) return [`"${target}" isn't an owner/name repo`];
    const permissions = p.permissions ?? {};
    const problems = Object.entries(permissions)
      .filter(([, level]) => !POLICY_LEVELS.has(level))
      .map(([name, level]) => `Permission ${name} is "${level}"; it must be "read" or "write"`);
    if (problems.length) return problems;

    const found = await this.installation(p.source, target);
    if (!found) return [p.source ? `${p.source} isn't installed on ${target}` : `No GitHub App on the router is installed on ${target}`];
    const { slug, installation } = found;
    if (installation.suspended_at) return [`${slug}'s installation on ${installation.account.login} is suspended`];
    for (const [name, level] of Object.entries(permissions)) {
      if (!covers(installation.permissions[name], level)) {
        const granted = installation.permissions[name];
        problems.push(`${slug} has ${granted ? `${name}: ${granted}` : `no ${name} permission`} on ${installation.account.login}; the policy wants ${name}: ${level}`);
      }
    }
    if (problems.length) return problems;

    // The installation may cover only selected repos. Minting a token narrowed
    // to the target is the one definitive check that it covers this one.
    try {
      await this.apps.token(slug, installation.id, { repositories: [target.split("/")[1]!], permissions: { metadata: "read" } });
    } catch (error) {
      return [`${slug}'s installation on ${installation.account.login} doesn't cover ${target}: ${(error as Error).message}`];
    }
    return [];
  }

  /**
   * One token per repo and App, at the highest level its policies ask for.
   * Not one per installation, because a token's permissions apply to all its
   * repos. A repo with `contents: read` would get `write` if it shared a token
   * with one that needs write.
   * The config's own repo comes first, since gh uses the first token.
   */
  async mint(policies: PolicyData[], repo: string): Promise<PolicyCredential[]> {
    const groups = new Map<string, { source: string; installation: number; repos: string[]; permissions: Permissions }>();
    const lookups = new Map<string, Promise<{ slug: string; installation: InstallationInfo } | undefined>>();
    for (const policy of policies) {
      const p = policy as GitHubPolicyData;
      if (p.provider !== POLICY_PROVIDER) continue;
      const target = p.repo ?? repo;
      if (!REPO.test(target)) throw new Error(`"${target}" isn't an owner/name repo`);
      const lookupKey = `${p.source ?? ""}\n${target.toLowerCase()}`;
      if (!lookups.has(lookupKey)) lookups.set(lookupKey, this.installation(p.source, target));
      const found = await lookups.get(lookupKey)!;
      if (!found) throw new Error(p.source ? `${p.source} isn't installed on ${target}` : `No GitHub App on the router is installed on ${target}`);
      const { slug, installation } = found;
      const key = `${slug}\n${installation.id}\n${target.toLowerCase()}`;
      const group = groups.get(key) ?? { source: slug, installation: installation.id, repos: [], permissions: {} };
      groups.set(key, group);
      if (!group.repos.some((r) => r.toLowerCase() === target.toLowerCase())) group.repos.push(target);
      for (const [name, level] of Object.entries(p.permissions)) group.permissions[name] = maxLevel(group.permissions[name], level);
    }
    const own = (g: { repos: string[] }) => (g.repos[0]!.toLowerCase() === repo.toLowerCase() ? 0 : 1);
    return Promise.all(
      [...groups.values()].sort((a, b) => own(a) - own(b)).map(async (g) => {
        const token = await this.apps.token(g.source, g.installation, { repositories: g.repos.map((r) => r.split("/")[1]!), permissions: g.permissions });
        return {
          provider: POLICY_PROVIDER,
          value: token.token,
          expiresAt: token.expires_at,
          scope: { source: g.source, installation: g.installation, repos: g.repos, permissions: g.permissions },
        };
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
  async install(credentials: PolicyCredential[], dir: string): Promise<{ env: Record<string, string> }> {
    const mine = credentials.filter((c) => c.provider === POLICY_PROVIDER);
    const ghDir = path.join(dir, GH_CONFIG_DIR);
    fs.mkdirSync(ghDir, { recursive: true, mode: 0o700 });

    const files = new Set<string>();
    const entries: { repo: string; tokenFile: string }[] = [];
    mine.forEach((credential, i) => {
      const name = tokenFileName(credential, i);
      const file = path.join(dir, name);
      writeAtomic(file, credential.value);
      files.add(name);
      const repos = Array.isArray(credential.scope.repos) ? credential.scope.repos : [];
      for (const repo of repos) if (typeof repo === "string" && REPO.test(repo)) entries.push({ repo, tokenFile: file });
    });

    const gitconfig = path.join(dir, GIT_CONFIG_FILE);
    writeAtomic(gitconfig, gitConfig(entries));

    const first = mine[0];
    const hosts = path.join(ghDir, GH_HOSTS_FILE);
    if (first) {
      const user = typeof first.scope.source === "string" ? botLogin(first.scope.source) : "x-access-token";
      writeAtomic(hosts, `github.com:\n    oauth_token: ${first.value}\n    user: ${user}\n    git_protocol: https\n`);
    } else {
      fs.rmSync(hosts, { force: true });
    }

    // Remove token files no credential uses any more.
    for (const name of fs.readdirSync(dir)) if (name.endsWith(TOKEN_SUFFIX) && !files.has(name)) fs.rmSync(path.join(dir, name), { force: true });

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
