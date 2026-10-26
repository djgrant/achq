// The router's and deployer's routes, declared once in core's wire: served, faked and called
// from the same declarations. The `@ts-expect-error` lines are the proof that drift is a type
// error: `pok typecheck` fails if any of them stops being one.
import { describe, expect, expectTypeOf, test } from "bun:test";
import type { DeployerVersion, DeployRecord, RouterRepoConfig, SyncRequest, SyncStarted, SyncStatus } from "@achq/core/protocol";
import { deployerClient } from "@achq/core/clients/deployer";
import { repoParams, routerAdmin, routerForPusher } from "@achq/core/clients/router";
import { deployerRoutes } from "@achq/core/routes/deployer";
import { routerAdminRoutes } from "@achq/core/routes/router-admin";
import { adminSecret } from "@achq/core/secrets";
import { signedFetcher } from "@achq/core/signing";
import { HttpError } from "@achq/utils/http";
import { serve } from "@achq/utils/routes";
import { Hono } from "hono";
import { config, deployed, fakeContainer, key, repo } from "./harness.ts";

describe("drift between a route and what serves or calls it is a type error", () => {
  test("a server or fake answering what its route doesn't declare", () => {
    const app = new Hono();
    serve(app, routerAdminRoutes.status, (c) => c.json([{ repo, state: "deployed" as const, at: "now" }], 200));
    // @ts-expect-error A state DeployRecord doesn't have.
    serve(app, routerAdminRoutes.status, (c) => c.json([{ repo, state: "deploying", at: "now" }], 200));
    // @ts-expect-error A status the route doesn't declare: the deployer's sync answers 202.
    serve(app, deployerRoutes.sync, (c) => c.json({ id: "s1" }, 200));
    // @ts-expect-error The sync's ID under another name.
    serve(app, deployerRoutes.sync, (c) => c.json({ sync: "s1" }, 202));
    // @ts-expect-error JSON where the route declares text.
    serve(app, routerAdminRoutes.syncStatus, (c) => c.json({ error: "no such sync" }, 404));
    // @ts-expect-error The admin route's 204 answered with a body.
    serve(app, routerAdminRoutes.putRepo, (c) => c.json({ ok: true }, 204));
    expect(app).toBeDefined();
  });

  test("a client calling a route as it isn't declared", () => {
    const admin = routerAdmin({ url: "http://router", key });
    const deployer = deployerClient(signedFetcher(adminSecret(key), "http://deployer"));
    // Checked by tsc only: bun's runtime expectTypeOf doesn't implement `parameter` and `returns`.
    const types = () => {
      expectTypeOf(admin.putRepo).parameter(0).toEqualTypeOf<{ params: { owner: string; name: string }; body: RouterRepoConfig }>();
      expectTypeOf(admin.putRepo).returns.resolves.toEqualTypeOf<void>();
      expectTypeOf(admin.sync).parameter(0).toEqualTypeOf<{ body: SyncRequest }>();
      expectTypeOf(admin.sync).returns.resolves.toEqualTypeOf<SyncStarted>();
      expectTypeOf(admin.syncStatus).returns.resolves.toEqualTypeOf<SyncStatus>();
      expectTypeOf(admin.status).toEqualTypeOf<() => Promise<DeployRecord[]>>();
      expectTypeOf(admin.deployerVersion).toEqualTypeOf<() => Promise<DeployerVersion>>();
      // The router's forwarded routes answer what the deployer's do.
      expectTypeOf(deployer.version).returns.resolves.toEqualTypeOf<Awaited<ReturnType<typeof admin.deployerVersion>>>();
      expectTypeOf(deployer.status).returns.resolves.toEqualTypeOf<Awaited<ReturnType<typeof admin.status>>>();
    };
    const wrong = () => {
      // @ts-expect-error A route the deployer doesn't declare, as a renamed one would be.
      void deployer.deployerVersion();
      // @ts-expect-error The repo as one string, not its owner and name.
      void admin.deleteRepo({ params: { repo } });
      // @ts-expect-error A sync's request without its body.
      void admin.sync({ dryRun: true });
      // @ts-expect-error A field SyncRequest doesn't have.
      void admin.sync({ body: { dry: true } });
      // @ts-expect-error The pusher's client has only the routes for the repo CLI.
      void routerForPusher({ url: "http://router", token: "t" }).webhook();
    };
    expect(types).toBeFunction();
    expect(wrong).toBeFunction();
  });
});

describe("the router's admin client", () => {
  test("fills params, signs, and parses what the router answers", async () => {
    const r = await deployed();
    const client = routerAdmin({ url: r.priv, key });
    expect((await client.listRepos()).map((c) => c.repo)).toEqual([repo]);
    const body = config(fakeContainer("dev"), fakeContainer("docsbox"));
    expect(await client.putRepo({ params: repoParams(repo), body })).toBeUndefined();
    expect(await client.validate({ body: { repo, policies: [{ provider: "nope" }] } })).toEqual({ problems: ['No policy provider "nope"'] });
    expect(await client.installed()).toEqual([{ repo }]);

    // A refusal throws HttpError with its status and body.
    const bad = await client.putRepo({ params: repoParams("acme/other"), body }).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(HttpError);
    expect((bad as HttpError).message).toBe("Router PUT /repos/acme/other: 400 bad config");
    await expect(routerAdmin({ url: r.priv, key: "wrong" }).listRepos()).rejects.toMatchObject({ status: 401 });
    // A param its route's schema refuses isn't sent.
    await expect(client.putRepo({ params: { owner: "a b", name: "w" }, body })).rejects.toThrow();
  });
});
