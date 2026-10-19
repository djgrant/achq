import * as fs from "node:fs";
import * as path from "node:path";
import type { AccessCredential, AccessProvider, PolicyData } from "@achq/core";
import { ACCESS, CHANNEL, REPO } from "../lib/constants.ts";
import { GH_CONFIG_DIR, GH_HOSTS_FILE, GIT_CONFIG_FILE, POLICY_LEVELS, TOKEN_SUFFIX } from "./constants.ts";
import type { RepoPolicyData } from "../resources/repo-policy.ts";
import type { Apps } from "../lib/apps.ts";
import { botLogin } from "../lib/bot.ts";
import { gitConfig } from "./git-credentials.ts";
import { covers, maxLevel, type Permissions } from "../lib/permissions.ts";

/** Writes a file so a reader sees the old content or the new, never half of either. */
const writeAtomic = (file: string, content: string) => {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
};

/** Named by App and installation, so a refresh never points a repo at another installation's token. */
const tokenFileName = (credential: AccessCredential, index: number) => {
  const { app, installation, repos } = credential.scope;
  const repo = Array.isArray(repos) && repos.length === 1 ? `-${repos[0]}` : "";
  const name = typeof app === "string" && typeof installation === "number" ? `${app}-${installation}${repo}` : String(index);
  return `${name.replace(/[^A-Za-z0-9_.-]/g, "_")}${TOKEN_SUFFIX}`;
};

export class GitHubAccess implements AccessProvider {
  readonly id = ACCESS;

  constructor(private apps: Apps) {}

  /** A policy goes through its App, the channel's source. */
  policySource(policy: PolicyData) {
    return typeof policy.app === "string" ? { channel: CHANNEL, source: policy.app } : undefined;
  }

  async validate(policy: PolicyData, repo: string): Promise<string[]> {
    const p = policy as Partial<RepoPolicyData>;
    if (p.access !== ACCESS) return [`Policy is for access "${p.access}", not github`];
    if (typeof p.app !== "string" || !this.apps.has(p.app)) return [`GitHub App "${p.app}" isn't configured on the router`];
    const target = p.repo ?? repo;
    if (typeof target !== "string" || !REPO.test(target)) return [`"${target}" isn't an owner/name repo`];
    const permissions = p.permissions ?? {};
    const problems = Object.entries(permissions)
      .filter(([, level]) => !POLICY_LEVELS.has(level))
      .map(([name, level]) => `Permission ${name} is "${level}"; it must be "read" or "write"`);
    if (problems.length) return problems;

    const installation = await this.apps.installation(p.app, target);
    if (!installation) return [`${p.app} isn't installed on ${target}`];
    if (installation.suspended_at) return [`${p.app}'s installation on ${installation.account.login} is suspended`];
    for (const [name, level] of Object.entries(permissions)) {
      if (!covers(installation.permissions[name], level)) {
        const granted = installation.permissions[name];
        problems.push(`${p.app} has ${granted ? `${name}: ${granted}` : `no ${name} permission`} on ${installation.account.login}; the policy wants ${name}: ${level}`);
      }
    }
    if (problems.length) return problems;

    // The installation may cover only selected repos. Minting a token narrowed
    // to the target is the one definitive check that it covers this one.
    try {
      await this.apps.token(p.app, installation.id, { repositories: [target.split("/")[1]!], permissions: { metadata: "read" } });
    } catch (error) {
      return [`${p.app}'s installation on ${installation.account.login} doesn't cover ${target}: ${(error as Error).message}`];
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
  async mint(policies: PolicyData[], repo: string): Promise<AccessCredential[]> {
    const groups = new Map<string, { app: string; installation: number; repos: string[]; permissions: Permissions }>();
    const lookups = new Map<string, Promise<Awaited<ReturnType<Apps["installation"]>>>>();
    for (const policy of policies) {
      const p = policy as RepoPolicyData;
      if (p.access !== ACCESS) continue;
      const target = p.repo ?? repo;
      if (!REPO.test(target)) throw new Error(`"${target}" isn't an owner/name repo`);
      const lookupKey = `${p.app}\n${target.toLowerCase()}`;
      if (!lookups.has(lookupKey)) lookups.set(lookupKey, this.apps.installation(p.app, target));
      const installation = await lookups.get(lookupKey)!;
      if (!installation) throw new Error(`${p.app} isn't installed on ${target}`);
      const key = `${p.app}\n${installation.id}\n${target.toLowerCase()}`;
      const group = groups.get(key) ?? { app: p.app, installation: installation.id, repos: [], permissions: {} };
      groups.set(key, group);
      if (!group.repos.some((r) => r.toLowerCase() === target.toLowerCase())) group.repos.push(target);
      for (const [name, level] of Object.entries(p.permissions)) group.permissions[name] = maxLevel(group.permissions[name], level);
    }
    const own = (g: { repos: string[] }) => (g.repos[0]!.toLowerCase() === repo.toLowerCase() ? 0 : 1);
    return Promise.all(
      [...groups.values()].sort((a, b) => own(a) - own(b)).map(async (g) => {
        const token = await this.apps.token(g.app, g.installation, { repositories: g.repos.map((r) => r.split("/")[1]!), permissions: g.permissions });
        return {
          access: ACCESS,
          value: token.token,
          expiresAt: token.expires_at,
          scope: { app: g.app, installation: g.installation, repos: g.repos, permissions: g.permissions },
        };
      }),
    );
  }

  /**
   * Container side, no network. Writes each token to
   * `dir/<app>-<installation>-<repo>.token`, plus gh's `hosts.yml` and a git
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
  async install(credentials: AccessCredential[], dir: string): Promise<{ env: Record<string, string> }> {
    const mine = credentials.filter((c) => c.access === ACCESS);
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
      const user = typeof first.scope.app === "string" ? botLogin(first.scope.app) : "x-access-token";
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
