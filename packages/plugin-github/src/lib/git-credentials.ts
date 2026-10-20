import * as fs from "node:fs";
import * as path from "node:path";
import type { PolicyCredential } from "@achq/core";
import { safeFileName, writeFileAtomicSync } from "@achq/utils/fs";

export const GH_CONFIG_DIR = "gh";
export const GH_HOSTS_FILE = "hosts.yml";
export const GIT_CONFIG_FILE = "gitconfig";
export const TOKEN_SUFFIX = ".token";

const gitQuote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Git config that gives each repo URL its own token, so tokens from different
 * installations can coexist. Each repo gets a `credential.<url>` section, which
 * git matches against the remote's full URL.
 *
 * `credential.useHttpPath` passes the path to helpers too, so a caching helper
 * can't hand one repo's token to another.
 *
 * Each section resets the helper list first, so no other helper (a keychain,
 * `gh auth git-credential`) answers for these repos.
 *
 * Both `…/name.git` and `…/name` are listed, because a remote can use either
 * and git matches paths by whole components.
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

/** Tokens and the files that point at them are only the owner's to read. */
const SECRET_MODE = 0o600;

/** Writes a file only its owner can read, so a reader sees the old content or the new, never half of either. */
export const writeSecretFile = (file: string, content: string) => writeFileAtomicSync(file, content, { mode: SECRET_MODE });

export const ghHostsYml = (token: string, user: string) => `github.com:\n    oauth_token: ${token}\n    user: ${user}\n    git_protocol: https\n`;

export const removeStaleTokens = (dir: string, keep: Set<string>) => {
  for (const name of fs.readdirSync(dir)) if (name.endsWith(TOKEN_SUFFIX) && !keep.has(name)) fs.rmSync(path.join(dir, name), { force: true });
};

/** Named by source App and installation, so a refresh never points a repo at another installation's token. */
export const tokenFileName = (credential: PolicyCredential, index: number) => {
  const { source, installation, repos } = credential.scope;
  const repo = Array.isArray(repos) && repos.length === 1 ? `-${repos[0]}` : "";
  const name = typeof source === "string" && typeof installation === "number" ? `${source}-${installation}${repo}` : String(index);
  return `${safeFileName(name)}${TOKEN_SUFFIX}`;
};
