import type { Prompter } from "@pokit/core";
import { ghToken, userGitHub } from "../gh.ts";
import { readStatus } from "../status/read.ts";
import { interactive } from "../terminal.ts";
import { containersOf, type Located, pickContainer } from "./containers.ts";
import { wake } from "./wake.ts";

/** The repo's container, picked and woken through the router. */
export const reachContainer = async (prompter: Prompter, repo: string, wanted?: string): Promise<Located> => {
  const status = await readStatus(userGitHub(), repo);
  if (!status) throw new Error(`${repo} has no ACHQ_STATUS: it hasn't been deployed`);
  const containers = containersOf(status);
  let container = pickContainer(containers, wanted);
  if (!container) {
    if (!interactive()) throw new Error(`${repo} has several containers; pick one with --container (${containers.map((c) => c.name).join(", ")})`);
    const name = await prompter.select({ message: "Container", options: containers.map((c) => ({ value: c.name, label: c.name })) });
    container = containers.find((c) => c.name === name)!;
  }
  if (!status.router) throw new Error(`${repo}'s ACHQ_STATUS doesn't say where the router is`);
  await wake(status.router, repo, container.name, ghToken());
  return container;
};
