import { describe, expect, test } from "bun:test";
import { deployed, repo } from "./harness.ts";

const wakeDev = { repo, container: "dev" };

describe("wake", () => {
  test("rejects a missing token or one without push access, without waking anything", async () => {
    const r = await deployed();
    expect((await r.wake(wakeDev)).status).toBe(401);
    expect((await r.wake(wakeDev, "read-token")).status).toBe(403);
    expect((await r.wake(wakeDev, "forged")).status).toBe(403);
    expect(r.dev.wakes).toBe(0);
  });

  test("rejects a request without a container", async () => {
    const r = await deployed();
    expect((await r.wake({ repo }, "push-token")).status).toBe(400);
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
