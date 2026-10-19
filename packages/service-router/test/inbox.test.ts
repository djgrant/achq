import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { accepted, boot, comment, deployed, deliveryIds, readJson, hold } from "./harness.ts";

describe("persisted events", () => {
  test("the delivery is on the volume before the router answers, and gone once delivered", async () => {
    const r = await deployed();
    const gate = hold(r.dev);
    const event = comment(10);
    const res = await r.webhook(event);
    expect(res.status).toBe(202);
    const file = join(r.dir, "inbox", `${event.delivery}.json`);
    // The container hasn't answered, and the delivery is already persisted.
    const stored = readJson(file);
    expect(stored.event.delivery).toBe(event.delivery!);
    expect(stored.targets.map((t: any) => [t.container, t.commit])).toEqual([["dev", "abc123"]]);
    await gate.reached;
    gate.release();
    await r.router.settled();
    expect(existsSync(file)).toBe(false);
  });

  test("a router started on the same volume replays what's left in the inbox", async () => {
    const first = await deployed();
    const gate = hold(first.dev);
    const event = comment(11);
    await first.webhook(event);
    await gate.reached;
    // The first router is stuck mid-forward, as if it crashed. A new one starts on its volume.
    first.dev.respond = accepted;
    const second = await boot({ dir: first.dir });
    await second.router.settled();
    expect(deliveryIds(first.dev)).toEqual([event.delivery!, event.delivery!]);
    expect(existsSync(join(first.dir, "inbox", `${event.delivery}.json`))).toBe(false);
    gate.release();
    await first.router.settled();
  });

  test("a duplicate delivery ID isn't queued twice", async () => {
    const r = await deployed();
    const gate = hold(r.dev);
    const event = comment(12);
    expect(await (await r.webhook(event)).text()).toBe("accepted");
    expect(await (await r.webhook(event)).text()).toBe("duplicate");
    await gate.reached;
    gate.release();
    await r.router.settled();
    expect(deliveryIds(r.dev)).toEqual([event.delivery!]);
  });

  test("retries while a container wakes", async () => {
    const r = await deployed();
    let calls = 0;
    r.dev.respond = () => (++calls < 3 ? new Response("waking", { status: 502 }) : accepted());
    await r.webhook(comment(13));
    await r.router.settled();
    expect(r.dev.attempts).toBe(3);
    expect(existsSync(join(r.dir, "failed"))).toBe(false);
  });

  test("a target that runs out of retries lands in failed/ with the error, and leaves the inbox", async () => {
    const r = await deployed();
    r.dev.respond = () => new Response("down", { status: 503 });
    const event = comment(14);
    await r.webhook(event);
    await r.router.settled();
    expect(r.dev.attempts).toBe(3);
    const failed = readJson(join(r.dir, "failed", `${event.delivery}.json`));
    expect(failed.event.delivery).toBe(event.delivery!);
    expect(failed.targets[0].container).toBe("dev");
    expect(failed.targets[0].error).toContain("gave up after 3 attempts (503 down)");
    expect(existsSync(join(r.dir, "inbox", `${event.delivery}.json`))).toBe(false);
  });
});
