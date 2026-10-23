import type { DeployerVersion, SyncStatus } from "@achq/core";
import { DeployerEnvelope, SyncRequest } from "@achq/core/protocol";
import { adminSecret } from "@achq/core/secrets";
import { signedBy } from "@achq/core/signing";
import { errors } from "@achq/utils/errors";
import { http } from "@achq/utils/http";
import { zValidator } from "@hono/zod-validator";
import type { Deployer } from "./deployer.ts";

/** How many syncs' outcomes it keeps for `GET /sync/<id>`. */
const KEPT_SYNCS = 10;

/**
 * Every route but health takes only requests signed with the admin secret. A
 * sync runs in the background, as its builds can take longer than any hop
 * keeps a request open: `POST /sync` answers with its ID, and `GET /sync/<id>`
 * with how it's going.
 */
export const deployerHandler = (deployer: Deployer, key: string, log: (line: string) => void = console.error) => {
  const syncs = new Map<string, SyncStatus>();
  const startSync = (request: SyncRequest) => {
    const id = crypto.randomUUID();
    syncs.set(id, { state: "running" });
    for (const old of [...syncs.keys()].slice(0, -KEPT_SYNCS)) syncs.delete(old);
    deployer.sync(request).then(
      (result) => syncs.set(id, { state: "done", result }),
      (error) => {
        log(`deployer sync ${id}: ${errors.detail(error)}`);
        syncs.set(id, { state: "failed" });
      },
    );
    return id;
  };
  return http.service((line) => log(`deployer ${line}`))
    .use(signedBy(adminSecret(key)))
    .post("/events", zValidator("json", DeployerEnvelope), async (c) => {
      // Answered once handled, so the router keeps the delivery until it's done.
      await deployer.handle(c.req.valid("json"));
      return c.body(null, 202);
    })
    .post("/sync", zValidator("json", SyncRequest), async (c) => {
      return c.json({ id: startSync(c.req.valid("json")) }, 202);
    })
    .get("/sync/:id", (c) => {
      const status = syncs.get(c.req.param("id"));
      return status ? c.json(status) : c.text("no such sync", 404);
    })
    .get("/version", (c) => c.json({ ref: deployer.ref } satisfies DeployerVersion))
    .get("/status", async (c) => c.json(await deployer.status())).fetch;
};
