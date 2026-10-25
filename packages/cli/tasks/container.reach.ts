import { defineTask } from "@pokit/core";
import { routerForPusher } from "@achq/core/clients/router";
import { z } from "zod";
import { chooseOne } from "../io/terminal.ts";
import { notSetUp, type RepoHere } from "../io/workdir.ts";
import { containersOf, pickContainer } from "../pickers/container.ts";
import { given } from "./params.ts";
import { runner } from "./run.ts";

/** The repo's container, the one `wanted` names or picked at the terminal, and woken through the router. */
export const containerReach = defineTask({
  label: "Reach the container",
  params: z.object({ here: given<RepoHere>(), wanted: z.string().optional() }),
  run: async (r, { params: { here, wanted } }) => {
    const { repo, codeHost } = here;
    // ACHQ_STATUS says where the repo's containers are, and which router fronts them.
    const status = await codeHost.status(repo);
    if (!status) throw new Error(notSetUp(repo));
    const containers = containersOf(status);
    const container = await chooseOne(runner(r).prompter, containers, pickContainer(containers, wanted, repo), {
      message: "Container",
      id: (c) => c.name,
      label: (c) => c.name,
      withoutTerminal: () => {
        throw new Error(`${repo} has several containers; pick one with --container (${containers.map((c) => c.name).join(", ")})`);
      },
    });
    // The router checks, on the code host, that you can push to the repo.
    await routerForPusher({ url: status.router, token: codeHost.token() }).wake({ body: { repo, container: container.name } });
    return container;
  },
});
