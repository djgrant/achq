import { describe, expect, test } from "bun:test";
import { config, deployed, repo } from "./harness.ts";

const wakeDev = { host: "test", repo, container: "dev" };

describe("wake", () => {
  test("rejects a missing token or one without push access, without waking anything", async () => {
    const r = await deployed();
    expect((await r.wake(wakeDev)).status).toBe(401);
    expect((await r.wake(wakeDev, "read-token")).status).toBe(403);
    expect((await r.wake(wakeDev, "forged")).status).toBe(403);
    expect(r.dev.wakes).toBe(0);
  });

  test("rejects a request without a host, or naming one the router doesn't know", async () => {
    const r = await deployed();
    expect((await r.wake({ repo, container: "dev" }, "push-token")).status).toBe(400);
    const unknown = await r.wake({ ...wakeDev, host: "elsewhere" }, "push-token");
    expect([unknown.status, await unknown.text()]).toEqual([400, "unknown host"]);
    expect(r.dev.wakes).toBe(0);
  });

  test("a repo deployed from another host isn't woken", async () => {
    const r = await deployed();
    const elsewhere = { ...config(r.dev, r.docsbox), host: "other" };
    expect((await r.admin("PUT", `/admin/repos/${repo}`, elsewhere)).status).toBe(204);
    const res = await r.wake(wakeDev, "push-token");
    expect([res.status, await res.text()]).toEqual([404, "not deployed"]);
    expect(r.dev.wakes).toBe(0);
  });

  test("wakes a deployed container, retrying until it answers", async () => {
    const r = await deployed();
    let calls = 0;
    r.dev.wakeRespond = () => (++calls < 3 ? new Response("starting", { status: 503 }) : new Response("ok"));
    const res = await r.wake(wakeDev, "push-token");
    expect([res.status, await res.text()]).toEqual([200, "awake"]);
    expect(r.dev.wakes).toBe(3);
    expect((await r.wake({ ...wakeDev, container: "ghost" }, "push-token")).status).toBe(404);
  });

  test("answers 504 when the container never wakes", async () => {
    const r = await deployed();
    r.docsbox.wakeRespond = () => new Response("down", { status: 503 });
    expect((await r.wake({ ...wakeDev, container: "docsbox" }, "push-token")).status).toBe(504);
  });
});
