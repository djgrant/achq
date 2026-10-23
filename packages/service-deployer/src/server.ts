import type { DeployerVersion, JobStatus } from "@achq/core";
import { DeployerEnvelope, SyncRequest, TeardownRequest } from "@achq/core/protocol";
import { adminSecret } from "@achq/core/secrets";
import { signedBy } from "@achq/core/signing";
import { errors } from "@achq/utils/errors";
import { http } from "@achq/utils/http";
import { zValidator } from "@hono/zod-validator";
import type { Deployer } from "./deployer.ts";

/** How many jobs' outcomes it keeps for `GET /sync/<id>` and `GET /teardown/<id>`. */
const KEPT_JOBS = 10;

/**
 * Every route but health takes only requests signed with the admin secret. A
 * sync or teardown runs in the background, as its builds can take longer than
 * any hop keeps a request open: `POST /sync` answers with its ID, and
 * `GET /sync/<id>` with how it's going.
 */
export const deployerHandler = (deployer: Deployer, key: string, log: (line: string) => void = console.error) => {
  const jobs = new Map<string, JobStatus<unknown>>();
  const start = (what: string, run: () => Promise<unknown>) => {
    const id = crypto.randomUUID();
    jobs.set(id, { state: "running" });
    for (const old of [...jobs.keys()].slice(0, -KEPT_JOBS)) jobs.delete(old);
    run().then(
      (result) => jobs.set(id, { state: "done", result }),
      (error) => {
        log(`deployer ${what} ${id}: ${errors.detail(error)}`);
        jobs.set(id, { state: "failed" });
      },
    );
    return id;
  };
  const job = (id: string) => {
    const status = jobs.get(id);
    return status ? Response.json(status) : new Response("no such job", { status: 404 });
  };
  return http.service((line) => log(`deployer ${line}`))
    .use(signedBy(adminSecret(key)))
    .post("/events", zValidator("json", DeployerEnvelope), async (c) => {
      // Answered once handled, so the router keeps the delivery until it's done.
      await deployer.handle(c.req.valid("json"));
      return c.body(null, 202);
    })
    .post("/sync", zValidator("json", SyncRequest), async (c) => {
      const { prune = false, dryRun = false } = c.req.valid("json");
      return c.json({ id: start("sync", () => deployer.sync({ prune, dryRun })) }, 202);
    })
    .get("/sync/:id", (c) => job(c.req.param("id")))
    .post("/teardown", zValidator("json", TeardownRequest), async (c) => {
      const { dryRun = false } = c.req.valid("json");
      return c.json({ id: start("teardown", () => deployer.teardown({ dryRun })) }, 202);
    })
    .get("/teardown/:id", (c) => job(c.req.param("id")))
    .get("/version", (c) => c.json({ ref: deployer.ref } satisfies DeployerVersion))
    .get("/status", async (c) => c.json(await deployer.status())).fetch;
};
