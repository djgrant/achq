import { describe, expect, test } from "bun:test";
import type { RouterRepoConfig } from "@achq/core";
import { containerSecret } from "@achq/core/secrets";
import { signedHeaders } from "@achq/core/signing";
import { key, repo, fakeDeployer, boot, policy, config, comment, deployed, deliveryIds } from "./harness.ts";

describe("admin", () => {
  test("pushed router config survives a restart, and a delete does too", async () => {
    const r = await deployed();
    const again = await boot({ dir: r.dir });
    const repos = (await (await again.admin("GET", "/admin/repos", undefined, again.pub)).json()) as RouterRepoConfig[];
    expect(repos.map((c) => c.repo)).toEqual([repo]);
    const event = comment(20);
    await again.webhook(event);
    await again.router.settled();
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
    const { host: _host, ...hostless } = config(r.dev, r.docsbox);
    expect((await r.admin("PUT", `/admin/repos/${repo}`, hostless)).status).toBe(400);
  });

  test("mint, validate, installed repos and sources", async () => {
    const r = await deployed();
    const minted = (await (await r.admin("POST", "/admin/mint", { repo, policies: [policy("deploy")] }, r.pub)).json()) as { value: string }[];
    expect(minted.map((c: any) => c.value)).toEqual(["token:deploy"]);
    const validated = await (await r.admin("POST", "/admin/validate", { repo, policies: [policy("ok"), { ...policy("bad"), ok: false }, { provider: "nope" }] })).json();
    expect(validated).toEqual({ problems: ["bad isn't allowed", 'No policy provider "nope"'] });
    expect(await (await r.admin("GET", "/admin/installed")).json()).toEqual([{ host: "test", repo }]);
    expect(((await (await r.admin("GET", "/admin/sources")).json()) as { source: string }[])[0].source).toBe("app");
  });

  test("teardown is forwarded to the deployer", async () => {
    const r = await boot({ deployer: fakeDeployer().url });
    const started = await r.admin("POST", "/admin/teardown", { dryRun: true });
    expect(started.status).toBe(202);
    expect(await started.json()).toEqual({ id: "t1" });
    expect(await (await r.admin("GET", "/admin/teardown/t1")).json()).toEqual({ state: "done", result: { removed: [`${repo}/dev`] } });
  });

  test("sync and status are forwarded to the deployer, waking it", async () => {
    const deployer = fakeDeployer();
    const r = await boot({ deployer: deployer.url });
    const sync = await r.admin("POST", "/admin/sync", { dryRun: true }, r.pub);
    expect(sync.status).toBe(202);
    expect(await sync.json()).toEqual({ id: "s1" });
    expect(deployer.syncs).toBe(2);
    expect(await (await r.admin("GET", "/admin/sync/s1")).json()).toMatchObject({ state: "done", result: { deployed: [repo] } });
    expect(await (await r.admin("GET", "/admin/status")).json()).toEqual([{ repo, state: "deployed" }]);
  });
});
