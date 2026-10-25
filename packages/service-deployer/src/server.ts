import type { DeployerVersion, SyncStarted, SyncStatus } from "@achq/core";
import { DeployerEnvelope, SyncRequest } from "@achq/core/protocol";
import { adminSecret } from "@achq/core/secrets";
import { signedBy } from "@achq/core/signing";
import { http } from "@achq/utils/http";
import { zValidator } from "@hono/zod-validator";
import type { Deployer } from "./deployer.ts";

/**
 * Every route but health takes only requests signed with the admin secret. A
 * sync runs in the background, as its builds can take longer than any hop
 * keeps a request open: `POST /sync` answers with its ID, and `GET /sync/<id>`
 * with how it's going, kept in the deployer's store so a restart doesn't lose
 * it. One that stopped when its deployer did is interrupted.
 */
export const deployerHandler = (deployer: Deployer, key: string, log: (line: string) => void = console.error) => {
  return http.service((line) => log(`deployer ${line}`))
    .use(signedBy(adminSecret(key)))
    .post("/events", zValidator("json", DeployerEnvelope), async (c) => {
      // Answered once handled, so the router keeps the delivery until it's done.
      await deployer.handle(c.req.valid("json"));
      return c.body(null, 202);
    })
    .post("/sync", zValidator("json", SyncRequest), async (c) => {
      const request = c.req.valid("json");
      return c.json({ id: await deployer.syncs.start(() => deployer.sync(request)) } satisfies SyncStarted, 202);
    })
    .get("/sync/:id", async (c) => {
      const status = await deployer.syncs.status(c.req.param("id"));
      if (!status) return c.text("no such sync", 404);
      // A failed one's error is only logged.
      return c.json((status.state === "failed" ? { state: "failed" } : status) satisfies SyncStatus);
    })
    .get("/version", (c) => c.json({ ref: deployer.ref } satisfies DeployerVersion))
    .get("/status", async (c) => c.json(await deployer.status())).fetch;
};
