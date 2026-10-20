import type { Prompter } from "@pokit/core";
import type { Status } from "@achq/core";
import { chooseOne } from "../choose.ts";
import type { RepoHere } from "../workdir.ts";
import { containersOf, type Located, pickContainer } from "./containers.ts";
import { wake } from "./wake.ts";

/** The repo's ACHQ_STATUS, which says where its containers are. */
const deployedStatus = async ({ repo, codeHost }: RepoHere): Promise<Status> => {
  const status = await codeHost.status(repo);
  if (!status) throw new Error(`${repo} has no ACHQ_STATUS: it hasn't been deployed`);
  return status;
};

/** The repo's container, picked and woken through the router. */
export const reachContainer = async (prompter: Prompter, here: RepoHere, wanted?: string): Promise<Located> => {
  const { host, repo, codeHost } = here;
  const status = await deployedStatus(here);
  const containers = containersOf(status);
  const container = await chooseOne(prompter, containers, pickContainer(containers, wanted), {
    message: "Container",
    id: (c) => c.name,
    label: (c) => c.name,
    withoutTerminal: () => {
      throw new Error(`${repo} has several containers; pick one with --container (${containers.map((c) => c.name).join(", ")})`);
    },
  });
  await wake(status.router, { host, repo, container: container.name }, codeHost.token());
  return container;
};
