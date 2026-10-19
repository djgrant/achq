import type { Prompter } from "@pokit/core";
import { interactive } from "../terminal.ts";
import type { RepoHere } from "../workdir.ts";
import { containersOf, type Located, pickContainer } from "./containers.ts";
import { wake } from "./wake.ts";

/** The repo's container, picked and woken through the router. */
export const reachContainer = async (prompter: Prompter, { host, repo, codeHost }: RepoHere, wanted?: string): Promise<Located> => {
  const status = await codeHost.status(repo);
  if (!status) throw new Error(`${repo} has no ACHQ_STATUS: it hasn't been deployed`);
  const containers = containersOf(status);
  let container = pickContainer(containers, wanted);
  if (!container) {
    if (!interactive()) throw new Error(`${repo} has several containers; pick one with --container (${containers.map((c) => c.name).join(", ")})`);
    const name = await prompter.select({ message: "Container", options: containers.map((c) => ({ value: c.name, label: c.name })) });
    container = containers.find((c) => c.name === name)!;
  }
  await wake(status.router, { host, repo, container: container.name }, codeHost.token());
  return container;
};
