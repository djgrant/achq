import { describe, expect, test } from "bun:test";
import type { RouterRepoConfig } from "@achq/core";
import { containerSecret } from "@achq/core/secrets";
import { signedHeaders } from "@achq/core/signing";
import { routerAdmin } from "@achq/core/clients/router";
import { key, repo, fakeDeployer, boot, policy, config, comment, deployed, deliveryIds, serve } from "./harness.ts";

describe("admin", () => {
  test("pushed router config survives a restart, and a delete does too", async () => {
    const r = await deployed();
    const again = await boot({ dir: r.dir });
    const repos = (await (await again.admin("GET", "/admin/repos", undefined, again.pub)).json()) as RouterRepoConfig[];
    expect(repos.map((c) => c.repo)).toEqual([repo]);
    const event = comment(20);
    await again.webhook(event);
    await again.settled();
    expect(deliveryIds(r.dev)).toEqual([event.delivery!]);

    await again.admin("DELETE", `/admin/repos/${repo}`);
    const third = await boot({ dir: r.dir });
    expect(await (await third.admin("GET", "/admin/repos")).json()).toEqual([]);
  });

  test("admin requests need the admin signature, for this method and path", async () => {
    const r = await deployed();
    expect((await fetch(`${r.pub}/admin/repos`)).status).toBe(401);
    // Container secrets aren't admin.
    const path = "/admin/repos";
    expect((await fetch(`${r.priv}${path}`, { headers: signedHeaders(containerSecret(key, repo, "dev"), "GET", path, "") })).status).toBe(401);
    // A config for another repo than the path names.
    expect((await r.admin("PUT", "/admin/repos/acme/other", config(r.dev, r.docsbox))).status).toBe(400);
    // A segment that's only dots isn't a repo name, so the route's params refuse it; dotted names are.
    expect((await r.admin("PUT", "/admin/repos/.../widgets", config(r.dev, r.docsbox))).status).toBe(400);
    expect((await r.admin("PUT", "/admin/repos/acme.co/wid.gets", config(r.dev, r.docsbox))).status).toBe(400);
    const { commit: _commit, ...uncommitted } = config(r.dev, r.docsbox);
    expect((await r.admin("PUT", `/admin/repos/${repo}`, uncommitted)).status).toBe(400);
  });

  test("mint, validate, installed repos and sources", async () => {
    const r = await deployed();
    const minted = (await (await r.admin("POST", "/admin/mint", { repo, policies: [policy("deploy")] }, r.pub)).json()) as { value: string }[];
    expect(minted.map((c: any) => c.value)).toEqual(["token:deploy"]);
    const validated = await (await r.admin("POST", "/admin/validate", { repo, policies: [policy("ok"), { ...policy("bad"), ok: false }, { provider: "nope" }] })).json();
    expect(validated).toEqual({ problems: ["bad isn't allowed", 'No policy provider "nope"'] });
    expect(await (await r.admin("GET", "/admin/installed")).json()).toEqual([{ repo }]);
    expect(((await (await r.admin("GET", "/admin/sources")).json()) as { source: string }[])[0].source).toBe("app");
  });

  test("sync and status are forwarded to the deployer, waking it", async () => {
    const deployer = fakeDeployer();
    const r = await boot({ deployer: deployer.url });
    const sync = await r.admin("POST", "/admin/sync", { dryRun: true }, r.pub);
    expect(sync.status).toBe(202);
    expect(await sync.json()).toEqual({ id: "s1" });
    expect(deployer.syncs).toBe(2);
    expect(await (await r.admin("GET", "/admin/sync/s1")).json()).toMatchObject({ state: "done", result: { deployed: [repo] } });
    expect(await (await r.admin("GET", "/admin/status")).json()).toEqual([{ repo, state: "deployed", at: "2026-10-25T00:00:00.000Z" }]);
    // The deployer's `/version`, by the router's name for it.
    expect(await (await r.admin("GET", "/admin/deployer")).json()).toEqual({ ref: "abc123" });
  });

  test("a forwarded sync is validated before it reaches the deployer", async () => {
    const deployer = fakeDeployer();
    const r = await boot({ deployer: deployer.url });
    expect((await r.admin("POST", "/admin/sync", { dryRun: "yes" })).status).toBe(400);
    expect(deployer.syncs).toBe(0);
  });

  test("the deployer's refusal keeps its status and body", async () => {
    const deployer = fakeDeployer();
    const r = await boot({ deployer: deployer.url });
    const res = await r.admin("GET", "/admin/sync/nope");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("no such sync");
    // Through the client, it's the HttpError the CLI starts a lost sync again on.
    const client = routerAdmin({ url: r.priv, key });
    await expect(client.syncStatus({ params: { id: "nope" } })).rejects.toMatchObject({ status: 404, body: "no such sync" });
  });

  test("a deployer that never answers is a 504 saying so", async () => {
    const r = await boot({ deployer: "http://localhost:1" });
    const res = await r.admin("GET", "/admin/status");
    expect(res.status).toBe(504);
    expect(await res.text()).toStartWith("gave up after 3 attempts");
  });

  test("an answer the deployer gives that isn't its route's is the router's error, not the deployer's", async () => {
    const odd = serve(async () => Response.json({ state: "lost" }));
    const r = await boot({ deployer: odd });
    const res = await r.admin("GET", "/admin/sync/s1");
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("internal error");
  });
});
