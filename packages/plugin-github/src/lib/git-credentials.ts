// The files that make agents' tokens usable by git and gh, as
// `GitHubPolicyProvider.install` writes them in its directory.

export const GH_CONFIG_DIR = "gh";
export const GH_HOSTS_FILE = "hosts.yml";
export const GIT_CONFIG_FILE = "gitconfig";
export const TOKEN_SUFFIX = ".token";

/** A double-quoted git config value. */
const gitQuote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
/** A single-quoted shell word. */
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
