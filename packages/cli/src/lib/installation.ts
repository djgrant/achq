// `achq install` and `uninstall`: the resources the installation provider of
// each channel the config names makes for the repo, planned and printed. They
// act as you.
import { plan } from "@achq/core";
import { installationProviderNamed } from "achq/registry";
import { openInBrowser } from "./browser.ts";
import { planLines } from "./changes.ts";
import { cliContext } from "./context.ts";
import { channelsOf, loadRepoManifest } from "./load/repo-config.ts";
import { needRepo, repoRoot } from "./workdir.ts";

/** Plans installing (or removing) this repo's sources and prints the plan. `apply` is undefined when nothing would change. */
export const planInstallation = async (installed: boolean) => {
  const { repo, codeHost } = needRepo();
  const config = await loadRepoManifest(repoRoot());
  const resources = channelsOf(config).flatMap((id) => installationProviderNamed(id).create(process.env).installation(repo, config, installed));
  const planned = await plan(resources, cliContext({ env: process.env, log: (line) => console.log(line), open: openInBrowser }));
  for (const line of planLines(planned)) console.log(line);
  if (!planned.changes.length) {
    const names = resources.map((r) => r.name);
    const verb = names.length === 1 ? (installed ? "is" : "isn't") : installed ? "are" : "aren't";
    console.log(`${names.join(", ")} ${verb} ${installed ? "already " : ""}installed on ${repo}`);
  }
  return { repo, codeHost, apply: planned.changes.length ? () => planned.apply() : undefined };
};
