import { describe, expect, test } from "bun:test";
import { messageId } from "../src/lib/threads.ts";
import { commentPayload, installation, issuePayload, parse, parseRepo, repository, user } from "./payloads.ts";

describe("parse", () => {
  test("an issue comment becomes a small event on its thread, without the payload", () => {
    const event = parse("issue_comment", commentPayload("created"))!;
    expect(event).toEqual({
      channel: "github",
      source: "notation-achq",
      delivery: "d-1",
      type: "issue_comment.created",
      repo: "notationlabs/yieldstar",
      thread: { channel: "github", id: "notationlabs/yieldstar#42" },
      labels: ["docs"],
      actor: { login: "dan", trusted: true, bot: false },
      text: "@claude please look",
      message: messageId(9001),
      detail: { issue: 42, comment: 9001 },
    });
  });

  test("an edit carries the text before it", () => {
    const event = parse("issue_comment", commentPayload("edited", { body: "now @claude", from: "before" }))!;
    expect(event.type).toBe("issue_comment.edited");
    expect([event.text, event.previousText]).toEqual(["now @claude", "before"]);
  });

  test("an issue edit that didn't change the body has the same text before", () => {
    const payload = { action: "edited", issue: issuePayload({ body: "@claude hi" }), changes: { title: { from: "Old" } }, repository, installation };
    const event = parse("issues", payload)!;
    expect([event.text, event.previousText]).toEqual(["@claude hi", "@claude hi"]);
  });

  test("comments on pull requests, deleted comments and closed issues are skipped", () => {
    expect(parse("issue_comment", commentPayload("created", { issue: issuePayload({ pr: true }) }))).toBeUndefined();
    expect(parse("issue_comment", commentPayload("deleted"))).toBeUndefined();
    expect(parse("issues", { action: "closed", issue: issuePayload(), repository })).toBeUndefined();
    expect(parse("ping", { zen: "Keep it logically awesome.", hook_id: 1 })).toBeUndefined();
  });

  test("a trusted comment on an untrusted author's issue is untrusted; bots are marked", () => {
    const onStranger = parse("issue_comment", commentPayload("created", { issue: issuePayload({ author: "eve", association: "NONE" }) }))!;
    expect(onStranger.actor).toEqual({ login: "dan", trusted: false, bot: false });
    const fromStranger = parse("issue_comment", commentPayload("created", { author: "eve", association: "CONTRIBUTOR" }))!;
    expect(fromStranger.actor!.trusted).toBe(false);
    const bot = parse("issue_comment", commentPayload("created", { author: "dependabot[bot]", type: "Bot", association: "NONE" }))!;
    expect(bot.actor!.bot).toBe(true);
  });

  test("issue events take the actor and text from the issue; labeled names the label", () => {
    const event = parse("issues", { action: "labeled", issue: issuePayload({ labels: ["docs", "bug"] }), label: { name: "bug" }, repository, sender: user("dan"), installation })!;
    expect(event.type).toBe("issues.labeled");
    expect(event.labels).toEqual(["docs", "bug"]);
    expect(event.text).toBe("Please fix it");
    expect(event.detail).toEqual({ issue: 42, label: "bug" });
    expect(event.previousText).toBeUndefined();
  });

  const push = (commits: { added?: string[]; modified?: string[]; removed?: string[] }[], ref = "refs/heads/main") => ({
    ref,
    before: "a".repeat(40),
    after: "b".repeat(40),
    created: false,
    deleted: false,
    forced: false,
    commits: commits.map((c, i) => ({ id: String(i), message: "m", added: [], modified: [], removed: [], ...c })),
    head_commit: null,
    repository: { ...repository, default_branch: "main" },
    pusher: { name: "dan" },
    sender: user("dan"),
    installation,
  });

  test("a push to the default branch is for the deployer when any commit touched .achq/, by any kind of change; any other push is nothing", () => {
    const changed = (...args: Parameters<typeof push>) => parseRepo("push", push(...args)) !== undefined;
    expect(changed([{ modified: ["src/a.ts"] }])).toBe(false);
    expect(changed([{ modified: ["src/a.ts"] }, { removed: [".achq/Dockerfile"] }])).toBe(true);
    expect(changed([{ added: [".achq/config.ts"] }])).toBe(true);
    // Not a prefix match on the name alone.
    expect(changed([{ added: [".achqx/config.ts", "docs/.achq/x"] }])).toBe(false);
    expect(changed([{ added: [".achq/config.ts"] }], "refs/heads/feature")).toBe(false);
    expect(parseRepo("push", push([{ added: [".achq/config.ts"] }]))).toEqual({ delivery: "d-1", type: "push", host: "github", deploy: ["notationlabs/yieldstar"], uninstall: [], onlyIfDeployed: true });
  });

  test("a push listing GitHub's maximum of 2048 commits may have changed the config", () => {
    expect(parseRepo("push", push(Array.from({ length: 2047 }, () => ({}))))).toBeUndefined();
    expect(parseRepo("push", push(Array.from({ length: 2048 }, () => ({}))))?.deploy).toEqual(["notationlabs/yieldstar"]);
  });

  test("installations deploy the repos added and uninstall the ones removed, whether or not they're deployed yet", () => {
    const account = { login: "notationlabs", type: "Organization" };
    const created = parseRepo("installation", {
      action: "created",
      installation: { id: 77, account },
      repositories: [{ id: 1, name: "a", full_name: "notationlabs/a", private: true }, { id: 2, name: "b", full_name: "notationlabs/b", private: false }],
      sender: user("dan"),
    })!;
    expect(created).toEqual({ delivery: "d-1", type: "installation.created", host: "github", deploy: ["notationlabs/a", "notationlabs/b"], uninstall: [], onlyIfDeployed: false });
    const deleted = parseRepo("installation", { action: "deleted", installation: { id: 77, account }, repositories: [{ full_name: "notationlabs/a" }] })!;
    expect([deleted.deploy, deleted.uninstall]).toEqual([[], ["notationlabs/a"]]);
    const suspended = parseRepo("installation", { action: "suspend", installation: { id: 77, account }, repositories: [{ full_name: "notationlabs/a" }] })!;
    expect(suspended.type).toBe("installation.suspend");
    expect([suspended.deploy, suspended.uninstall]).toEqual([[], ["notationlabs/a"]]);
    const unsuspended = parseRepo("installation", { action: "unsuspend", installation: { id: 77, account }, repositories: [{ full_name: "notationlabs/a" }] })!;
    expect([unsuspended.deploy, unsuspended.uninstall]).toEqual([["notationlabs/a"], []]);
    const changed = parseRepo("installation_repositories", {
      action: "removed",
      installation: { id: 77, account },
      repository_selection: "selected",
      repositories_added: [],
      repositories_removed: [{ id: 3, name: "c", full_name: "notationlabs/c" }],
    })!;
    expect(changed.type).toBe("installation_repositories.removed");
    expect([changed.deploy, changed.uninstall]).toEqual([[], ["notationlabs/c"]]);
    expect(parseRepo("installation", { action: "new_permissions_accepted", installation: { id: 77, account } })).toBeUndefined();
  });
});
