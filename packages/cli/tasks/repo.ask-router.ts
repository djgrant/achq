import { defineTask } from "@pokit/core";
import type { RepoInstallation } from "@achq/core";
import { routerForPusher } from "@achq/core/clients/router";
import { HttpError } from "@achq/utils/http";
import { z } from "zod";
import type { RepoHere } from "../io/workdir.ts";
import { given } from "./params.ts";

const NOT_FOUND = 404;

/**
 * The router ACHQ_STATUS names, and whether `source` is installed on the repo
 * as it says: it checks you can push to the repo. Undefined when there's no
 * ACHQ_STATUS naming one, and no `installation` when nothing answers there: a
 * 404, as from a router torn down, or one that doesn't have the source.
 */
export const repoAskRouter = defineTask({
  label: "Ask the repo's router",
  params: z.object({ here: given<RepoHere>(), source: z.string() }),
  run: async (_r, { params: { here, source } }): Promise<{ router: string; installation?: RepoInstallation } | undefined> => {
    const { repo, codeHost } = here;
    const router = (await codeHost.status(repo))?.router;
    if (!router) return undefined;
    try {
      return { router, installation: await routerForPusher({ url: router, token: codeHost.token() }).installation({ body: { repo, source } }) };
    } catch (error) {
      if (error instanceof HttpError && error.status === NOT_FOUND) return { router };
      throw error;
    }
  },
});
