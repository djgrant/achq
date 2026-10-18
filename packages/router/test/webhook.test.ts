import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { repo, fakeDeployer, boot, selector, config, trusted, comment, deployed, deliveryIds, readJson, hold } from "./harness.ts";

describe("routing events to containers", () => {
  test("an event reaches only the containers with a workspace that would claim its thread", async () => {
    const r = await deployed();
    const plain = comment(1);
    expect((await r.webhook(plain)).status).toBe(202);
    await r.router.settled();
    expect(deliveryIds(r.dev)).toEqual([plain.delivery!]);
    expect(r.docsbox.events).toEqual([]);
    // Containers get the commit whose config the router holds.
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

  test("a claim keeps its container after relabelling, and another container whose workspace now matches also runs it", async () => {
    const r = await deployed();
    const thread = { channel: "test", id: `${repo}#4` };
    // dev claimed the unlabelled thread with its catch-all.
    expect((await r.asContainer(repo, "dev", "/claims", { repo, container: "dev", workspace: "dev-all", thread })).status).toBe(204);
    // docsbox claimed a docs thread that then loses its label.
    const docsThread = { channel: "test", id: `${repo}#5` };
    expect((await r.asContainer(repo, "docsbox", "/claims", { repo, container: "docsbox", workspace: "docs", thread: docsThread })).status).toBe(204);

    hold(r.dev);
    hold(r.docsbox);
    const relabelled = comment(4, ["docs"]);
    await r.webhook(relabelled);
    const unlabelled = comment(5, []);
    await r.webhook(unlabelled);
    const targets = (id: string) => readJson(join(r.dir, "inbox", `${id}.json`)).targets.map((t: any) => `${t.container}:${t.workspace}`);
    // dev stays on dev-all (the claim), not dev-docs; docsbox joins because its workspace matches now.
    expect(targets(relabelled.delivery!)).toEqual(["dev:dev-all", "docsbox:docs"]);
    // docsbox keeps the thread it claimed, though its selector no longer matches.
    expect(targets(unlabelled.delivery!)).toEqual(["dev:dev-all", "docsbox:docs"]);
  });

  test("claims are container-signed and only for that repo's own containers and workspaces", async () => {
    const r = await deployed();
    const thread = { channel: "test", id: `${repo}#6` };
    const claim = (container: string, workspace: string) => ({ repo, container, workspace, thread });
    // Signed as docsbox, claiming as dev.
    expect((await r.asContainer(repo, "docsbox", "/claims", claim("dev", "dev-all"))).status).toBe(401);
    expect((await r.asContainer(repo, "ghost", "/claims", claim("ghost", "dev-all"))).status).toBe(404);
    // A workspace of another container.
    expect((await r.asContainer(repo, "dev", "/claims", claim("dev", "docs"))).status).toBe(404);
    expect((await r.asContainer(repo, "dev", "/claims", claim("dev", "dev-all"), undefined, r.pub)).status).toBe(404);
  });

  test("claims survive a restart", async () => {
    const r = await deployed();
    const thread = { channel: "test", id: `${repo}#7` };
    await r.asContainer(repo, "docsbox", "/claims", { repo, container: "docsbox", workspace: "docs", thread });
    const again = await boot({ dir: r.dir });
    const event = comment(7);
    await again.webhook(event);
    await again.router.settled();
    expect(deliveryIds(r.docsbox)).toEqual([event.delivery!]);
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
    const install = { delivery: "inst-1", type: "installation_repositories.added", repo: "acme/new" };
    expect((await r.webhook(install)).status).toBe(202);
    await r.router.settled();
    expect(deployer.events.map((e) => e.event.delivery)).toEqual(["inst-1"]);
  });

  test("only pushes to a deployed repo's default branch that touch .achq/ (or can't say) reach the deployer", async () => {
    const deployer = fakeDeployer();
    const r = await deployed({ deployer: deployer.url });
    const push = (delivery: string, detail: object, forRepo = repo) => ({ delivery, type: "push", repo: forRepo, detail: { defaultBranch: "main", ...detail } });
    await r.webhook(push("p-touch", { ref: "refs/heads/main", touchesConfig: true }));
    await r.webhook(push("p-truncated", { ref: "refs/heads/main", touchesConfig: false, truncated: true }));
    await r.webhook(push("p-untouched", { ref: "refs/heads/main", touchesConfig: false }));
    await r.webhook(push("p-branch", { ref: "refs/heads/feature", touchesConfig: true }));
    await r.webhook(push("p-undeployed", { ref: "refs/heads/main", touchesConfig: true }, "acme/other"));
    await r.router.settled();
    expect(deployer.events.map((e) => e.event.delivery).sort()).toEqual(["p-touch", "p-truncated"]);
    expect(r.dev.attempts).toBe(0);
  });
});
