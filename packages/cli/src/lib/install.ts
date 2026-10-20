// `achq install` and `uninstall`: what the repo's code host makes to set it up
// for achq, or tear it down, from its config, planned and printed. It acts as
// you.
import type { CodeHostProvider, RepoManifest, Resource } from "@achq/core";
import { plan } from "@achq/core";
import { plural } from "@achq/utils/text";
import { openInBrowser } from "./browser.ts";
import { planLines } from "./changes.ts";
import { cliContext } from "./context.ts";
import { loadRepoManifest } from "./load/repo-config.ts";
import { needRepo, repoRoot } from "./workdir.ts";

export type InstallAction = "install" | "uninstall";

/** What the code host makes for `action`. */
const resourcesFor = (action: InstallAction, codeHost: CodeHostProvider, repo: string, config: RepoManifest): Resource[] =>
  action === "install" ? codeHost.install(repo, config) : codeHost.uninstall(repo, config);

/** When nothing would change, e.g. `app is already installed on a/b` or `app isn't installed on a/b`. */
const alreadyMessage = (action: InstallAction, names: string[], repo: string) => {
  const n = names.length;
  const state = action === "install" ? `${plural(n, "is", "are")} already installed` : `${plural(n, "isn't", "aren't")} installed`;
  return `${names.join(", ")} ${state} on ${repo}`;
};

/** Plans installing or uninstalling this repo on its code host and prints the plan. `apply` is undefined when nothing would change. */
export const planInstall = async (action: InstallAction) => {
  const { repo, codeHost } = needRepo();
  const config = await loadRepoManifest(repoRoot());
  const resources = resourcesFor(action, codeHost, repo, config);
  const planned = await plan(resources, cliContext({ env: process.env, log: (line) => console.log(line), open: openInBrowser }));
  for (const line of planLines(planned)) console.log(line);
  const nothingToDo = !planned.changes.length;
  if (nothingToDo) console.log(alreadyMessage(action, resources.map((r) => r.name), repo));
  return { repo, codeHost, apply: nothingToDo ? undefined : () => planned.apply() };
};
