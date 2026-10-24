import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stores } from "@achq/core";
import { dirStores } from "@achq/test-utils/stores";
import { repo, fakeDeployer, boot, selector, config, trusted, comment, deployed, deliveryIds, readJson, hold, accepted } from "./harness.ts";

describe("routing events to containers", () => {
  test("an event reaches only the containers with a workspace that would claim its thread", async () => {
    const r = await deployed();
    const plain = comment(1);
    expect((await r.webhook(plain)).status).toBe(202);
    await r.router.settled();
    expect(deliveryIds(r.dev)).toEqual([plain.delivery!]);
    expect(r.docsbox.events).toEqual([]);
    expect(r.dev.events[0].commit).toBe("abc123");
  });

  test("within a container the first matching workspace in declaration order is chosen", async () => {
    const r = await deployed();
    const gate = hold(r.dev);
    hold(r.docsbox);
    const docs = comment(2, ["docs"]);
    await r.webhook(docs);
    const plain = comment(3);
    await r.webhook(plain);
    const targets = (id: string) => readJson(join(r.dir, "inbox", `${id}.json`)).targets.map((t: any) => `${t.container}:${t.workspace}`);
    // dev-docs is declared before dev-all, so it takes the docs thread; the catch-all takes the rest.
    expect(targets(docs.delivery!)).toEqual(["dev:dev-docs", "docsbox:docs"]);
    expect(targets(plain.delivery!)).toEqual(["dev:dev-all"]);
    gate.release();
  });

  test("the container is told the workspace the router routed the thread to", async () => {
    const r = await deployed();
    await r.webhook(comment(3, ["docs"]));
    await r.router.settled();
    expect(r.dev.events.map((e) => e.workspace)).toEqual(["dev-docs"]);
    expect(r.docsbox.events.map((e) => e.workspace)).toEqual(["docs"]);
  });

  test("a claim keeps its container after relabelling, and another container whose workspace now matches also runs it", async () => {
    const r = await deployed();
    const targets = (id: string) => readJson(join(r.dir, "inbox", `${id}.json`)).targets.map((t: any) => `${t.container}:${t.workspace}`);
    hold(r.dev);
    hold(r.docsbox);
    // dev claims the unlabelled thread with its catch-all; both containers claim a docs thread.
    await r.webhook(comment(4));
    await r.webhook(comment(5, ["docs"]));

    const relabelled = comment(4, ["docs"]);
    await r.webhook(relabelled);
    const unlabelled = comment(5, []);
    await r.webhook(unlabelled);
    // dev stays on dev-all (the claim), not dev-docs; docsbox joins because its workspace matches now.
    expect(targets(relabelled.delivery!)).toEqual(["dev:dev-all", "docsbox:docs"]);
    // Both keep the thread they claimed, though their selectors no longer pick those workspaces.
    expect(targets(unlabelled.delivery!)).toEqual(["dev:dev-docs", "docsbox:docs"]);
  });

  test("a thread is claimed when its event is accepted, so it keeps its container after relabelling even if that container never answered", async () => {
    const r = await deployed();
    r.docsbox.respond = () => new Response("down", { status: 503 });
    await r.webhook(comment(10, ["docs"]));
    await r.router.settled();
    expect(readdirSync(join(r.dir, "failed"))).toHaveLength(1);

    // The docs label goes: docsbox has no workspace that matches now, but it claimed the thread.
    r.docsbox.respond = accepted;
    const relabelled = comment(10, []);
    await r.webhook(relabelled);
    await r.router.settled();
    expect(r.docsbox.events.at(-1)).toMatchObject({ event: { delivery: relabelled.delivery }, workspace: "docs" });
  });

  test("concurrent events on one thread go to the same workspace: the first claims it before its inbox write finishes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "achq-router-"));
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let writes = 0;
    // The first inbox write waits until the second event has been routed.
    const stores: Stores = (collection) => {
      const store = dirStores(dir)(collection);
      if (collection !== "inbox") return store;
      return Object.assign(Object.create(store), {
        write: async (name: string, value: any) => {
          if (++writes === 1) await gate;
          return store.write(name, value);
        },
      });
    };
    const r = await deployed({ dir, stores });
    const docs = comment(13, ["docs"]);
    const plain = comment(13, []);
    const first = r.webhook(docs);
    while (writes < 1) await Bun.sleep(5);
    const second = r.webhook(plain);
    while (writes < 2) await Bun.sleep(5);
    open();
    expect([(await first).status, (await second).status]).toEqual([202, 202]);
    await r.router.settled();
    expect(r.dev.events.map((e) => e.workspace)).toEqual(["dev-docs", "dev-docs"]);
    expect(readJson(join(dir, "claims", `${repo.replace("/", "__")}.json`))).toEqual({ [`test:${repo}#13`]: { dev: "dev-docs", docsbox: "docs" } });
  });

  test("a claim whose event never reaches the inbox is undone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "achq-router-"));
    let failing = true;
    const stores: Stores = (collection) => {
      const store = dirStores(dir)(collection);
      if (collection !== "inbox") return store;
      return Object.assign(Object.create(store), {
        write: async (name: string, value: any) => {
          if (failing) throw new Error("inbox down");
          return store.write(name, value);
        },
      });
    };
    const r = await deployed({ dir, stores });
    expect((await r.webhook(comment(14, ["docs"]))).status).toBe(500);
    failing = false;
    await r.webhook(comment(14, []));
    await r.router.settled();
    expect(r.dev.events.map((e) => e.workspace)).toEqual(["dev-all"]);
    expect(r.docsbox.events).toEqual([]);
  });

  test("a claim the store won't take is kept in memory, and its event is still forwarded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "achq-router-"));
    const stores: Stores = (collection) => {
      const store = dirStores(dir)(collection);
      if (collection !== "claims") return store;
      return Object.assign(Object.create(store), {
        write: async () => {
          throw new Error("claims down");
        },
      });
    };
    const r = await deployed({ dir, stores });
    const event = comment(15, ["docs"]);
    expect(await (await r.webhook(event)).text()).toBe("accepted");
    await r.router.settled();
    expect(deliveryIds(r.dev)).toEqual([event.delivery!]);
    expect(readdirSync(join(dir, "inbox"))).toEqual([]);
    // The claim holds in memory: the relabelled thread stays where it was.
    await r.webhook(comment(15, []));
    await r.router.settled();
    expect(r.dev.events.map((e) => e.workspace)).toEqual(["dev-docs", "dev-docs"]);
  });

  test("events that wake nothing claim nothing", async () => {
    const r = await deployed();
    await r.webhook(comment(11, ["docs"], { actor: { login: "stranger", trusted: false, bot: false } }));
    await r.webhook(comment(11, ["docs"], { actor: { login: "ci[bot]", trusted: true, bot: true } }));
    await r.webhook(comment(11, ["docs"], { type: "issue.opened" }));
    const relabelled = comment(11, []);
    await r.webhook(relabelled);
    await r.router.settled();
    expect(deliveryIds(r.dev)).toEqual([relabelled.delivery!]);
    expect(r.dev.events[0]!.workspace).toBe("dev-all");
    expect(r.docsbox.events).toEqual([]);
  });

  test("a claim on a workspace the config no longer has gives way to the first that matches now", async () => {
    const r = await deployed();
    await r.webhook(comment(12, ["docs"]));
    await r.router.settled();
    const renamed = config(r.dev, r.docsbox);
    renamed.workspaces = renamed.workspaces.map((w) => (w.name === "dev-docs" ? { ...w, name: "dev-docs2" } : w));
    expect((await r.admin("PUT", `/admin/repos/${repo}`, renamed)).status).toBe(204);
    await r.webhook(comment(12, []));
    await r.router.settled();
    expect(r.dev.events.map((e) => e.workspace)).toEqual(["dev-docs", "dev-all"]);
  });

  test("/claims is gone: containers don't claim threads", async () => {
    const r = await deployed();
    const thread = { channel: "test", id: `${repo}#6` };
    expect((await r.asContainer(repo, "dev", "/claims", { repo, container: "dev", workspace: "dev-all", thread })).status).toBe(404);
  });

  test("claims survive a restart, and an uninstall and reinstall", async () => {
    const r = await deployed();
    await r.webhook(comment(7, ["docs"]));
    await r.router.settled();
    const again = await boot({ dir: r.dir });
    expect((await again.admin("DELETE", `/admin/repos/${repo}`)).status).toBe(204);
    expect((await again.admin("PUT", `/admin/repos/${repo}`, config(r.dev, r.docsbox))).status).toBe(204);
    const event = comment(7);
    await again.webhook(event);
    await again.router.settled();
    expect(deliveryIds(r.docsbox).at(-1)).toBe(event.delivery!);
    expect(r.dev.events.at(-1)!.workspace).toBe("dev-docs");
  });

  test("untrusted, bot, unmatched and threadless events wake nothing", async () => {
    const r = await deployed();
    const drops = [
      comment(8, [], { actor: { login: "stranger", trusted: false, bot: false } }),
      comment(8, [], { actor: { login: "ci[bot]", trusted: true, bot: true } }),
      comment(8, [], { actor: undefined }),
      comment(8, [], { type: "issue.opened" }),
      comment(8, [], { thread: undefined }),
    ];
    for (const event of drops) expect(await (await r.webhook(event)).text()).toBe("no match");
    expect(await (await r.webhook({ type: "ping" })).text()).toBe("ignored");
    expect((await r.webhook(comment(8), "wrong-secret")).status).toBe(401);
    await r.router.settled();
    expect(r.dev.attempts + r.docsbox.attempts).toBe(0);
    expect(readdirSync(r.dir).includes("inbox") ? readdirSync(join(r.dir, "inbox")) : []).toEqual([]);
  });

  test("events on an undeployed repo wake nothing, and an undeployed repo stops receiving them", async () => {
    const r = await deployed();
    expect(await (await r.webhook(comment(9, [], { repo: "acme/other" }))).text()).toBe("no match");
    expect((await r.admin("DELETE", `/admin/repos/${repo}`)).status).toBe(204);
    expect(await (await r.webhook(comment(9))).text()).toBe("no match");
    await r.router.settled();
    expect(r.dev.attempts).toBe(0);
  });
});

describe("routing events to the deployer", () => {
  test("installation events reach the deployer even for undeployed repos", async () => {
    const deployer = fakeDeployer();
    const r = await boot({ deployer: deployer.url });
    const install = { delivery: "inst-1", type: "installed", host: "test", deploy: ["acme/new"], uninstall: [] };
    expect((await r.webhook(install)).status).toBe(202);
    await r.router.settled();
    expect(deployer.events.map((e) => e.event.delivery)).toEqual(["inst-1"]);
  });

  test("a push reaches the deployer only for a deployed repo", async () => {
    const deployer = fakeDeployer();
    const r = await deployed({ deployer: deployer.url });
    const push = (delivery: string, forRepo = repo) => ({ delivery, type: "push", host: "test", deploy: [forRepo], onlyIfDeployed: true });
    expect(await (await r.webhook(push("p-deployed"))).text()).toBe("accepted");
    expect(await (await r.webhook(push("p-undeployed", "acme/other"))).text()).toBe("no match");
    await r.router.settled();
    expect(deliveryIds(deployer)).toEqual(["p-deployed"]);
    expect(deployer.events[0]!.event).toEqual({ delivery: "p-deployed", type: "push", host: "test", deploy: [repo], uninstall: [] });
    expect(r.dev.attempts).toBe(0);
  });
});
