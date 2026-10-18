// The GitHub access provider: RepoPolicy data in, installation tokens out, and
// on the container, those tokens wired into git and gh.
import * as fs from "node:fs";
import * as path from "node:path";
import type { PolicyData } from "../core/resources.ts";
import type { AccessProvider, Credential } from "../core/types.ts";
import { Apps, covers, maxLevel, REPO, type Permissions } from "./apps.ts";
import { botLogin } from "./channel.ts";
import type { RepoPolicyData } from "./resources.ts";

export const PROVIDER = "github";

const LEVELS = new Set(["read", "write"]);

/** Writes a file so a reader sees the old content or the new, never half of either. */
const writeAtomic = (file: string, content: string) => {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
};

/** A double-quoted git config value. */
const gitQuote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
/** A single-quoted shell word. */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The token file for a credential: named by App and installation, so a refresh never points a repo at another installation's token. */
const tokenFileName = (credential: Credential, index: number) => {
  const { app, installation, repos } = credential.scope;
  const repo = Array.isArray(repos) && repos.length === 1 ? `-${repos[0]}` : "";
  const name = typeof app === "string" && typeof installation === "number" ? `${app}-${installation}${repo}` : String(index);
  return `${name.replace(/[^A-Za-z0-9_.-]/g, "_")}.token`;
};

/**
 * Writes the git config that gives each repo URL its own token, so tokens for
 * repos under different installations coexist. git picks `credential.<url>`
 * sections by the remote's full URL, path included; `credential.useHttpPath`
 * also keeps the path in what helpers see (and caches key on), so a caching
 * helper can't hand one repo's token to another. Each helper section first resets the
 * helper list, so no other helper (a keychain, `gh auth git-credential`)
 * answers for these repos. Both `…/name.git` and `…/name` are listed, since a
 * remote can be either; helper paths match on whole path components.
 */
export const gitConfig = (entries: { repo: string; tokenFile: string }[]) => {
  const lines = ["[credential]", "\tuseHttpPath = true"];
  for (const { repo, tokenFile } of entries) {
    const helper = `!f() { test "$1" = get && echo username=x-access-token && echo "password=$(cat ${shQuote(tokenFile)})"; }; f`;
    for (const url of [`https://github.com/${repo}.git`, `https://github.com/${repo}`]) {
      lines.push(`[credential ${gitQuote(url)}]`, "\thelper =", `\thelper = ${gitQuote(helper)}`);
    }
  }
  return lines.join("\n") + "\n";
};

export class GitHubAccess implements AccessProvider {
  readonly id = PROVIDER;

  constructor(private apps: Apps) {}

  async validate(policy: PolicyData, repo: string): Promise<string[]> {
    const p = policy as Partial<RepoPolicyData>;
    if (p.provider !== PROVIDER) return [`Policy is for provider "${p.provider}", not github`];
    if (typeof p.app !== "string" || !this.apps.has(p.app)) return [`GitHub App "${p.app}" isn't configured on the router`];
    const target = p.repo ?? repo;
    if (typeof target !== "string" || !REPO.test(target)) return [`"${target}" isn't an owner/name repo`];
    const permissions = p.permissions ?? {};
    const problems = Object.entries(permissions)
      .filter(([, level]) => !LEVELS.has(level))
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
   * One token per repo (and App), with the highest level its policies ask for.
   * Not one per installation: a token's permissions apply to all its repos, so
   * `contents: read` on another repo would become `write` alongside this one.
   * The config's own repo comes first, since gh uses the first token.
   */
  async mint(policies: PolicyData[], repo: string): Promise<Credential[]> {
    const groups = new Map<string, { app: string; installation: number; repos: string[]; permissions: Permissions }>();
    const lookups = new Map<string, Promise<Awaited<ReturnType<Apps["installation"]>>>>();
    for (const policy of policies) {
      const p = policy as RepoPolicyData;
      if (p.provider !== PROVIDER) continue;
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
          provider: PROVIDER,
          value: token.token,
          expiresAt: token.expires_at,
          scope: { app: g.app, installation: g.installation, repos: g.repos, permissions: g.permissions },
        };
      }),
    );
  }

  /**
   * Container side, no network. Writes each token to `dir/<app>-<installation>-<repo>.token`,
   * gh's `hosts.yml` (for the first credential: gh has one token per host) and
   * a git config with a helper per repo URL. Every file is replaced atomically,
   * so a refresh never shows a running git or gh a half-written token.
   *
   * The git config is included through `GIT_CONFIG_COUNT` rather than set as
   * `GIT_CONFIG_GLOBAL`, which would replace `~/.gitconfig` and lose what's
   * there (user.name, user.email, anything the image or the startup files set).
   * Env config is read last, so these helpers win over any others. The env is
   * the same on every refresh: only the files behind it change. A caller that
   * sets its own `GIT_CONFIG_COUNT` must merge, not overwrite.
   */
  async install(credentials: Credential[], dir: string): Promise<{ env: Record<string, string> }> {
    const mine = credentials.filter((c) => c.provider === PROVIDER);
    const ghDir = path.join(dir, "gh");
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

    const gitconfig = path.join(dir, "gitconfig");
    writeAtomic(gitconfig, gitConfig(entries));

    const first = mine[0];
    const hosts = path.join(ghDir, "hosts.yml");
    if (first) {
      const user = typeof first.scope.app === "string" ? botLogin(first.scope.app) : "x-access-token";
      writeAtomic(hosts, `github.com:\n    oauth_token: ${first.value}\n    user: ${user}\n    git_protocol: https\n`);
    } else {
      fs.rmSync(hosts, { force: true });
    }

    // Tokens no credential uses any more: after the config stops naming them.
    for (const name of fs.readdirSync(dir)) if (name.endsWith(".token") && !files.has(name)) fs.rmSync(path.join(dir, name), { force: true });

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
