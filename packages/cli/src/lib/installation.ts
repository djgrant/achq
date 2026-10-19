// `achq install` and `uninstall`: the resources each channel the config names
// makes for the repo, planned and printed. They act as you.
import { plan } from "@achq/core";
import { channelNamed } from "achq/registry";
import { openInBrowser } from "./browser.ts";
import { planLines } from "./changes.ts";
import { cliContext } from "./context.ts";
import { channelsOf, loadRepoPlan } from "./load/repo-config.ts";
import { needRepo, repoRoot } from "./workdir.ts";

/** Plans installing (or removing) this repo's sources and prints the plan. `apply` is undefined when nothing would change. */
export const planInstallation = async (installed: boolean) => {
  const { repo, repoHost } = needRepo();
  const config = await loadRepoPlan(repoRoot());
  const resources = channelsOf(config).flatMap((id) => channelNamed(id).create(process.env).installation(repo, config, installed));
  const planned = await plan(resources, cliContext({ env: process.env, log: (line) => console.log(line), open: openInBrowser }));
  for (const line of planLines(planned)) console.log(line);
  if (!planned.changes.length) {
    const names = resources.map((r) => r.name);
    const verb = names.length === 1 ? (installed ? "is" : "isn't") : installed ? "are" : "aren't";
    console.log(`${names.join(", ")} ${verb} ${installed ? "already " : ""}installed on ${repo}`);
  }
  return { repo, repoHost, apply: planned.changes.length ? () => planned.apply() : undefined };
};
