import { describe, expect, test } from "bun:test";
import { config, deployed, fakeContainer, fakeDeployer, repo } from "./harness.ts";

const reachDev = { repo, container: "dev", command: ["ls"], tty: true };

describe("reach", () => {
  test("rejects a missing token or one without push access, without waking anything", async () => {
    const r = await deployed();
    expect((await r.reach(reachDev)).status).toBe(401);
    expect((await r.reach(reachDev, "read-token")).status).toBe(403);
    expect((await r.reach(reachDev, "forged")).status).toBe(403);
    expect(r.dev.wakes).toBe(0);
  });

  test("rejects a request without a container or a command", async () => {
    const r = await deployed();
    expect((await r.reach({ repo }, "push-token")).status).toBe(400);
    expect((await r.reach({ repo, container: "dev" }, "push-token")).status).toBe(400);
    expect(r.dev.wakes).toBe(0);
  });

  test("wakes a deployed container, retrying until it answers, then answers with the deployer's shell for it", async () => {
    const r = await deployed({ deployer: fakeDeployer().url });
    let calls = 0;
    r.dev.wakeRespond = () => (++calls < 3 ? new Response("starting", { status: 503 }) : new Response("ok"));
    const res = await r.reach(reachDev, "push-token");
    expect([res.status, await res.json()]).toEqual([200, { argv: ["ssh", "-t", "dev", "ls"], requires: [] }]);
    expect(r.dev.wakes).toBe(3);
    expect((await r.reach({ ...reachDev, container: "nope" }, "push-token")).status).toBe(404);
  });

  test("passes on the deployer's refusal, and a 504 when it never answers", async () => {
    const ghost = fakeContainer("ghost");
    const r = await deployed({ deployer: fakeDeployer().url });
    const withGhost = config(r.dev, r.docsbox);
    withGhost.containers.push({ name: "ghost", url: ghost.url, policies: [] });
    expect((await r.admin("PUT", `/admin/repos/${repo}`, withGhost)).status).toBe(204);
    const refused = await r.reach({ ...reachDev, container: "ghost" }, "push-token");
    expect([refused.status, await refused.text()]).toEqual([404, "no such container"]);

    const unreachable = await deployed();
    expect((await unreachable.reach(reachDev, "push-token")).status).toBe(504);
  });

  test("answers 504 when the container never wakes", async () => {
    const r = await deployed();
    r.docsbox.wakeRespond = () => new Response("down", { status: 503 });
    expect((await r.reach({ ...reachDev, container: "docsbox" }, "push-token")).status).toBe(504);
  });
});
