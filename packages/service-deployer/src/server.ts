import { DeployerEnvelope, SyncRequest } from "@achq/core/protocol";
import { adminSecret } from "@achq/core/secrets";
import { signedBy } from "@achq/core/signing";
import { http } from "@achq/utils/http";
import { zValidator } from "@hono/zod-validator";
import type { Deployer } from "./deployer.ts";

/** Every route but health takes only requests signed with the admin secret. */
export const deployerHandler = (deployer: Deployer, key: string, log: (line: string) => void = console.error) =>
  http.service((line) => log(`deployer ${line}`))
    .use(signedBy(adminSecret(key)))
    .post("/events", zValidator("json", DeployerEnvelope), async (c) => {
      // Answered once handled, so the router keeps the delivery until it's done.
      await deployer.handle(c.req.valid("json"));
      return c.body(null, 202);
    })
    .post("/sync", zValidator("json", SyncRequest), async (c) => {
      const { prune = false, dryRun = false } = c.req.valid("json");
      return c.json(await deployer.sync({ prune, dryRun }));
    })
    .get("/status", async (c) => c.json(await deployer.status())).fetch;
