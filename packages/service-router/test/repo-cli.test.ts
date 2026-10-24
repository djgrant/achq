import { describe, expect, test } from "bun:test";
import { boot, fakeDeployer, repo } from "./harness.ts";

describe("installation", () => {
  test("says whether the source is installed on the repo, and where to change it, to someone who can push to it", async () => {
    const r = await boot();
    const res = await r.asYou("/installation", { repo, source: "app" }, "push-token");
    expect(await res.json()).toEqual({ installed: true, url: "https://test.example/settings/app" });
  });

  test("refuses a missing token or one without push access, and answers 404 for a source the router doesn't have", async () => {
    const r = await boot();
    const ask = { repo, source: "app" };
    expect((await r.asYou("/installation", ask)).status).toBe(401);
    expect((await r.asYou("/installation", ask, "read-token")).status).toBe(403);
    expect((await r.asYou("/installation", { ...ask, repo: "acme/other" }, "push-token")).status).toBe(403);
    const unknown = await r.asYou("/installation", { ...ask, source: "other-app" }, "push-token");
    expect([unknown.status, await unknown.text()]).toEqual([404, "unknown source"]);
  });
});

describe("deploy", () => {
  test("hands the deployer an install of the repo through the inbox, for someone who can push to it", async () => {
    const deployer = fakeDeployer();
    const r = await boot({ deployer: deployer.url });
    expect((await r.asYou("/deploy", { repo })).status).toBe(401);
    expect((await r.asYou("/deploy", { repo }, "read-token")).status).toBe(403);
    await r.router.settled();
    expect(deployer.events).toEqual([]);

    const res = await r.asYou("/deploy", { repo }, "push-token");
    expect([res.status, await res.text()]).toEqual([202, "accepted"]);
    await r.router.settled();
    expect(deployer.events.map((e) => e.event)).toEqual([{ delivery: expect.stringMatching(/^deploy-/), type: "deploy.requested", deploy: [repo], uninstall: [] }]);
  });
});
