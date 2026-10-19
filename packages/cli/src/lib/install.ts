// `achq install` and `uninstall`: what the repo's code host makes to set it up
// for achq, or tear it down, from its config, planned and printed. It acts as
// you.
import { plan } from "@achq/core";
import { openInBrowser } from "./browser.ts";
import { planLines } from "./changes.ts";
import { cliContext } from "./context.ts";
import { loadRepoManifest } from "./load/repo-config.ts";
import { needRepo, repoRoot } from "./workdir.ts";

/** Plans installing (or uninstalling) this repo on its code host and prints the plan. `apply` is undefined when nothing would change. */
export const planInstall = async (installed: boolean) => {
  const { repo, codeHost } = needRepo();
  const config = await loadRepoManifest(repoRoot());
  const resources = installed ? codeHost.install(repo, config) : codeHost.uninstall(repo, config);
  const planned = await plan(resources, cliContext({ env: process.env, log: (line) => console.log(line), open: openInBrowser }));
  for (const line of planLines(planned)) console.log(line);
  if (!planned.changes.length) {
    const names = resources.map((r) => r.name);
    const verb = names.length === 1 ? (installed ? "is" : "isn't") : installed ? "are" : "aren't";
    console.log(`${names.join(", ")} ${verb} ${installed ? "already " : ""}installed on ${repo}`);
  }
  return { repo, codeHost, apply: planned.changes.length ? () => planned.apply() : undefined };
};
