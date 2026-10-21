import * as fs from "node:fs";
import * as path from "node:path";
import { plan, type Status } from "@achq/core";
import { evaluateConfig } from "@achq/deployer/config";
import { async } from "@achq/utils/async";
import { disk } from "@achq/utils/disk";
import { subprocess } from "@achq/utils/subprocess";
import { text } from "@achq/utils/text";
import { STATUS_INTERVAL_MS, STATUS_TIMEOUT_MS } from "../constants.ts";
import { planLines } from "./format.ts";
import { cliContext } from "./infra.ts";
import { needRepo, repoRoot } from "./workdir.ts";

const CONFIG_DIR = ".achq";
const CONFIG_ENTRY = "config.ts";
/** Installed packages under `.achq/` are not part of the config. */
const SKIPPED_DIRS = ["node_modules"];

export type WaitOptions = { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> };

/** The repo's manifest, evaluated in the sandbox as the deployer does it, from every file under its `.achq/`. */
export const loadRepoManifest = async (repoDir: string) => {
  const dir = path.join(repoDir, CONFIG_DIR);
  if (!fs.existsSync(path.join(dir, CONFIG_ENTRY))) throw new Error(`No ${CONFIG_DIR}/${CONFIG_ENTRY} in ${repoDir}`);
  return evaluateConfig(disk.readTree(dir, { skip: SKIPPED_DIRS }));
};

/** Plans installing or uninstalling this repo on its code host and prints the plan. `apply` is undefined when nothing would change. */
export const planInstall = async (action: "install" | "uninstall") => {
  const { repo, codeHost } = needRepo();
  const config = await loadRepoManifest(repoRoot());
  const resources = action === "install" ? codeHost.install(repo, config) : codeHost.uninstall(repo, config);
  const planned = await plan(resources, cliContext({ env: process.env, log: (line) => console.log(line), open: async (url) => subprocess.openUrl(url) }));
  for (const line of planLines(planned)) console.log(line);
  if (planned.changes.length) return { repo, codeHost, apply: () => planned.apply() };
  // e.g. `app is already installed on a/b`, or `app isn't installed on a/b`.
  const n = resources.length;
  const state = action === "install" ? `${text.plural(n, "is", "are")} already installed` : `${text.plural(n, "isn't", "aren't")} installed`;
  console.log(`${resources.map((r) => r.name).join(", ")} ${state} on ${repo}`);
  return { repo, codeHost, apply: undefined };
};

/** The repo's status once one turns up that was written after `since`, rather than one left from before. Undefined if none does in time. */
export const waitForStatus = (
  status: (repo: string) => Promise<Status | undefined>,
  repo: string,
  since: Date,
  { timeoutMs = STATUS_TIMEOUT_MS, intervalMs = STATUS_INTERVAL_MS, sleep = Bun.sleep }: WaitOptions = {},
) => async.pollUntil(() => status(repo), (found) => !!found && Date.parse(found.at) > since.getTime(), { timeoutMs, intervalMs, sleep });
