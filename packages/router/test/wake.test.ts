import { describe, expect, test } from "bun:test";
import { repo, fakeGitHub, deployed } from "./harness.ts";

describe("wake", () => {
  test("rejects a missing token or one without push access, without waking anything", async () => {
    const r = await deployed({ github: fakeGitHub() });
    expect((await r.wake({ repo, container: "dev" })).status).toBe(401);
    expect((await r.wake({ repo, container: "dev" }, "read-token")).status).toBe(403);
    expect((await r.wake({ repo, container: "dev" }, "forged")).status).toBe(403);
    expect(r.dev.wakes).toBe(0);
  });

  test("wakes a deployed container, retrying until it answers", async () => {
    const r = await deployed({ github: fakeGitHub() });
    let calls = 0;
    r.dev.wakeRespond = () => (++calls < 3 ? new Response("starting", { status: 503 }) : new Response("ok"));
    const res = await r.wake({ repo, container: "dev" }, "push-token");
    expect([res.status, await res.text()]).toEqual([200, "awake"]);
    expect(r.dev.wakes).toBe(3);
    expect((await r.wake({ repo, container: "ghost" }, "push-token")).status).toBe(404);
  });

  test("answers 504 when the container never wakes", async () => {
    const r = await deployed({ github: fakeGitHub() });
    r.docsbox.wakeRespond = () => new Response("down", { status: 503 });
    expect((await r.wake({ repo, container: "docsbox" }, "push-token")).status).toBe(504);
  });
});
