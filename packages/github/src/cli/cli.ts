import type { ProviderCli } from "@achq/core";
import { checkApp } from "./app-check.ts";
import { configApp } from "./config-app.ts";
import { installRepo, uninstallRepo } from "./installation.ts";
import { lastCommit } from "./last-commit.ts";
import { repoOf } from "./remote.ts";
import { readStatus } from "./status.ts";
import { ghToken, userGitHub } from "./user.ts";

/** The repo commands, as your `gh` login. */
export const githubCli = (urls: { api: string; web: string }): ProviderCli => {
  const gh = userGitHub(urls.api);
  return {
    repoOf: (remote) => repoOf(remote, urls.web),
    token: ghToken,
    status: (repo) => readStatus(gh, repo),

    async install(repo, plan, { dryRun, open, log }) {
      const slug = configApp(plan);
      const check = await checkApp(gh, slug, plan);
      if (check.private) log(`${slug} is private, so GitHub won't show its settings; skipping the App check`);
      else if (check.missing.length) throw new Error(`${slug} doesn't have what ${repo}'s config needs: ${check.missing.join(", ")}`);
      else log(`${slug} has the events and permissions the config needs`);
      if (dryRun) return;
      const result = await installRepo(gh, slug, repo);
      if (result.kind === "open") {
        log(`${slug} isn't installed on ${repo.split("/")[0]} yet. Install it on ${repo} at ${result.url}`);
        await open(result.url);
      } else if (result.kind === "already") {
        log(`${slug} is already installed on ${repo}${result.all ? " (all repositories)" : ""}`);
      } else {
        log(`Installed ${slug} on ${repo}`);
      }
    },

    async uninstall(repo, plan) {
      const slug = configApp(plan);
      await uninstallRepo(gh, slug, repo);
      return `Removed ${repo} from ${slug}. Its containers sleep and are kept until \`achq up --prune\`.`;
    },

    lastCommit: (repo, branch, paths) => lastCommit(gh, repo, branch, paths),
  };
};
