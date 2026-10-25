import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dirStores } from "@achq/test-utils/stores";
import { accepted, boot, channelReplies, comment, config, deployed, deliveryIds, fakeContainer, fakeDeployer, readJson, hold, repo } from "./harness.ts";

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
    await r.settled();
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
    await second.settled();
    expect(deliveryIds(first.dev)).toEqual([event.delivery!, event.delivery!]);
    expect(existsSync(join(first.dir, "inbox", `${event.delivery}.json`))).toBe(false);
    gate.release();
    await first.settled();
  });

  test("a duplicate delivery ID isn't queued twice", async () => {
    const r = await deployed();
    const gate = hold(r.dev);
    const event = comment(12);
    expect(await (await r.webhook(event)).text()).toBe("accepted");
    expect(await (await r.webhook(event)).text()).toBe("duplicate");
    await gate.reached;
    gate.release();
    await r.settled();
    expect(deliveryIds(r.dev)).toEqual([event.delivery!]);
  });

  test("retries while a container wakes", async () => {
    const r = await deployed();
    let calls = 0;
    r.dev.respond = () => (++calls < 3 ? new Response("waking", { status: 502 }) : accepted());
    await r.webhook(comment(13));
    await r.settled();
    expect(r.dev.attempts).toBe(3);
    expect(existsSync(join(r.dir, "failed"))).toBe(false);
  });

  test("a target that runs out of retries lands in failed/ with the error, and leaves the inbox", async () => {
    const r = await deployed();
    r.dev.respond = () => new Response("down", { status: 503 });
    const event = comment(14);
    await r.webhook(event);
    await r.settled();
    expect(r.dev.attempts).toBe(3);
    const failed = readJson(join(r.dir, "failed", `${event.delivery}.json`));
    expect(failed.event.delivery).toBe(event.delivery!);
    expect(failed.targets[0].container).toBe("dev");
    expect(failed.targets[0].error).toContain("gave up after 3 attempts (503 down)");
    expect(existsSync(join(r.dir, "inbox", `${event.delivery}.json`))).toBe(false);
  });

  test("a thread whose container never answers is told so on the thread, once, as the channel's source", async () => {
    const r = await deployed();
    r.dev.respond = () => new Response("down", { status: 503 });
    const before = channelReplies.length;
    await r.webhook(comment(15));
    await r.settled();
    expect(channelReplies.slice(before)).toEqual([
      { thread: `${repo}#15`, as: "app", body: "⚠️ This didn't reach the agent: `dev` didn't answer. It's kept, and runs when someone replays it with `achq infra replay`." },
    ]);
  });

  test("GET /admin/failed lists each failed delivery, its targets and why", async () => {
    const r = await deployed();
    r.dev.respond = () => new Response("down", { status: 503 });
    const event = comment(16);
    await r.webhook(event);
    await r.settled();
    const res = await r.admin("GET", "/admin/failed");
    expect(await res.json()).toEqual([
      { delivery: event.delivery, type: "comment", repo, thread: event.thread, targets: [{ target: `${repo}/dev`, error: "gave up after 3 attempts (503 down)" }] },
    ]);
  });

  test("replaying sends failed deliveries to where their containers are now; one that fails again goes back to failed/ without telling the thread twice", async () => {
    const r = await deployed();
    r.dev.respond = () => new Response("down", { status: 503 });
    const event = comment(17);
    await r.webhook(event);
    await r.settled();
    const told = channelReplies.length;

    // Still down: back in failed/, and the thread isn't told again.
    expect(await (await r.admin("POST", "/admin/failed/replay")).json()).toEqual({ replayed: [event.delivery], dropped: [] });
    await r.settled();
    expect(channelReplies).toHaveLength(told);
    expect(readJson(join(r.dir, "failed", `${event.delivery}.json`)).told).toBe(true);

    // The container moved, and the config changed meanwhile: the replay goes to the new URL, with the new commit.
    const moved = fakeContainer("dev");
    expect((await r.admin("PUT", `/admin/repos/${repo}`, { ...config(moved, r.docsbox), commit: "def456" })).status).toBe(204);
    expect(await (await r.admin("POST", "/admin/failed/replay")).json()).toEqual({ replayed: [event.delivery], dropped: [] });
    await r.settled();
    expect(moved.events.map((e) => [e.event.delivery, e.commit])).toEqual([[event.delivery!, "def456"]]);
    expect(existsSync(join(r.dir, "failed", `${event.delivery}.json`))).toBe(false);
    expect(await (await r.admin("GET", "/admin/failed")).json()).toEqual([]);
  });

  test("replaying drops a failed delivery whose repo is no longer deployed", async () => {
    const r = await deployed();
    r.dev.respond = () => new Response("down", { status: 503 });
    const event = comment(18);
    await r.webhook(event);
    await r.settled();
    expect((await r.admin("DELETE", `/admin/repos/${repo}`)).status).toBe(204);
    expect(await (await r.admin("POST", "/admin/failed/replay")).json()).toEqual({ replayed: [], dropped: [event.delivery] });
    expect(existsSync(join(r.dir, "failed", `${event.delivery}.json`))).toBe(false);
    expect(r.dev.attempts).toBe(3);
  });

  test("a repo event the deployer never answers lands in failed/, is listed with its repos, and replays to the deployer", async () => {
    const deployer = fakeDeployer();
    deployer.respond = () => new Response("down", { status: 503 });
    const r = await boot({ deployer: deployer.url });
    const install = { delivery: "inst-failed", type: "installed", deploy: ["acme/new", "acme/newer"], uninstall: ["acme/old"] };
    await r.webhook(install);
    await r.settled();
    expect(readJson(join(r.dir, "failed", "inst-failed.json"))).toMatchObject({ to: "deployer", error: "gave up after 3 attempts (503 down)" });
    expect(await (await r.admin("GET", "/admin/failed")).json()).toEqual([
      { delivery: "inst-failed", type: "installed", repo: "acme/new, acme/newer, acme/old", targets: [{ target: "deployer", error: "gave up after 3 attempts (503 down)" }] },
    ]);

    deployer.respond = accepted;
    expect(await (await r.admin("POST", "/admin/failed/replay")).json()).toEqual({ replayed: ["inst-failed"], dropped: [] });
    await r.settled();
    expect(deployer.events.map((e) => e.event.delivery)).toEqual(["inst-failed", "inst-failed", "inst-failed", "inst-failed"]);
    expect(await (await r.admin("GET", "/admin/failed")).json()).toEqual([]);
  });

  test("a repo event the deployer refuses, as one a version behind does mid-rollout, lands in failed/ and replays once it takes it", async () => {
    const deployer = fakeDeployer();
    deployer.respond = () => new Response("bad event", { status: 400 });
    const r = await boot({ deployer: deployer.url });
    await r.webhook({ delivery: "inst-refused", type: "installed", deploy: ["acme/new"], uninstall: [] });
    await r.settled();
    // Refused at once: a refusal isn't retried.
    expect(deployer.events).toHaveLength(1);
    expect(readJson(join(r.dir, "failed", "inst-refused.json"))).toMatchObject({ to: "deployer", error: "refused (400 bad event)" });

    deployer.respond = accepted;
    expect(await (await r.admin("POST", "/admin/failed/replay")).json()).toEqual({ replayed: ["inst-refused"], dropped: [] });
    await r.settled();
    expect(deployer.events).toHaveLength(2);
    expect(await (await r.admin("GET", "/admin/failed")).json()).toEqual([]);
  });

  test("a container that refuses an event leaves it in failed/, as one that never answers does", async () => {
    const r = await deployed();
    r.dev.respond = () => new Response("bad envelope", { status: 400 });
    const event = comment(19);
    await r.webhook(event);
    await r.settled();
    expect(r.dev.attempts).toBe(1);
    expect(readJson(join(r.dir, "failed", `${event.delivery}.json`)).targets).toMatchObject([{ container: "dev", error: "refused (400 bad envelope)" }]);
  });

  // Delete with the inbox and failed migration in src/store.ts.
  test("entries an older router kept without saying where they go are tagged when it starts, then forwarded, listed and replayed as any are", async () => {
    const deployer = fakeDeployer();
    const first = await deployed({ deployer: deployer.url });
    const stores = dirStores(first.dir);
    const target = { repo, container: "dev", url: first.dev.url, workspace: "dev-all", commit: "abc123" };
    const install = { delivery: "old-install", type: "installed", host: "github", deploy: ["acme/new"], uninstall: [] };
    // As an older router kept them: each target said what it was, a repo event had a host, and a failed target its error.
    await stores("inbox").write("old-install", { event: install, targets: [{ kind: "deployer" }] });
    await stores("inbox").write("old-comment", { event: comment(40, [], { delivery: "old-comment" }), targets: [{ kind: "container", ...target }] });
    await stores("failed").write("old-failed-install", { event: { ...install, delivery: "old-failed-install" }, targets: [{ kind: "deployer", error: "gave up" }] });
    const failedComment = comment(41, [], { delivery: "old-failed-comment" });
    await stores("failed").write("old-failed-comment", { event: failedComment, targets: [{ kind: "container", ...target, error: "gave up" }], told: true });

    const r = await boot({ dir: first.dir, deployer: deployer.url });
    await r.settled();
    expect(deployer.events.map((e) => e.event)).toEqual([{ delivery: "old-install", type: "installed", deploy: ["acme/new"], uninstall: [] }]);
    expect(deliveryIds(first.dev)).toEqual(["old-comment"]);
    expect(await stores("failed").read("old-failed-install")).toEqual({ to: "deployer", event: { delivery: "old-failed-install", type: "installed", deploy: ["acme/new"], uninstall: [] }, error: "gave up" });
    expect(await stores("failed").read("old-failed-comment")).toEqual({ to: "containers", event: failedComment, targets: [{ ...target, error: "gave up" }], told: true });
    expect(await (await r.admin("GET", "/admin/failed")).json()).toEqual([
      { delivery: "old-failed-comment", type: "comment", repo, thread: failedComment.thread, targets: [{ target: `${repo}/dev`, error: "gave up" }] },
      { delivery: "old-failed-install", type: "installed", repo: "acme/new", targets: [{ target: "deployer", error: "gave up" }] },
    ]);

    expect(await (await r.admin("POST", "/admin/failed/replay")).json()).toEqual({ replayed: ["old-failed-comment", "old-failed-install"], dropped: [] });
    await r.settled();
    expect(deliveryIds(first.dev)).toEqual(["old-comment", "old-failed-comment"]);
    expect(deployer.events.map((e) => e.event.delivery)).toEqual(["old-install", "old-failed-install"]);
    expect(channelReplies.filter((c) => c.thread === `${repo}#41`)).toEqual([]);
  });
});
