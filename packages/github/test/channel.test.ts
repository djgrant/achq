import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appWebhookSecret } from "@achq/core/secrets";
import { hmacHex } from "@achq/core/signing";
import type { ChannelEvent } from "@achq/core";
import { FakeGitHub, makeApp } from "@achq/test-utils/github";
import { messageId, mentions, slugify } from "../src/runtime/channel.ts";
import type { EventSelectorData, IssueSelectorData } from "../src/resources.ts";
import { createGitHub } from "../src/runtime/index.ts";

const KEY = "the-webhook-key";

// ─── Payloads, shaped from https://docs.github.com/en/webhooks/webhook-events-and-payloads ───

const repository = { id: 1, name: "yieldstar", full_name: "notationlabs/yieldstar", owner: { login: "notationlabs" }, default_branch: "main" };
const installation = { id: 77, node_id: "MDIz" };
const user = (login: string, type = "User") => ({ login, id: login.length, type, site_admin: false });

const issuePayload = (over: { author?: string; association?: string; body?: string; labels?: string[]; pr?: boolean; type?: string } = {}) => ({
  url: "https://api.github.com/repos/notationlabs/yieldstar/issues/42",
  html_url: "https://github.com/notationlabs/yieldstar/issues/42",
  number: 42,
  title: "Fix the thing",
  user: user(over.author ?? "dan", over.type),
  labels: (over.labels ?? ["docs"]).map((name, id) => ({ id, name, color: "fff" })),
  state: "open",
  author_association: over.association ?? "OWNER",
  body: over.body ?? "Please fix it",
  ...(over.pr && { pull_request: { url: "https://api.github.com/repos/notationlabs/yieldstar/pulls/42" } }),
});

const commentPayload = (action: string, over: { body?: string; from?: string; association?: string; author?: string; type?: string; issue?: object } = {}) => ({
  action,
  issue: over.issue ?? issuePayload(),
  comment: {
    id: 9001,
    html_url: "https://github.com/notationlabs/yieldstar/issues/42#issuecomment-9001",
    user: user(over.author ?? "dan", over.type),
    created_at: "2026-10-18T10:00:00Z",
    updated_at: "2026-10-18T10:00:00Z",
    author_association: over.association ?? "OWNER",
    body: over.body ?? "@claude please look",
  },
  ...(over.from !== undefined && { changes: { body: { from: over.from } } }),
  repository,
  sender: user(over.author ?? "dan"),
  installation,
});

const headers = (event: string, body: string, over: Record<string, string | null> = {}) => {
  const h = new Headers({
    "x-github-event": event,
    "x-github-delivery": "d-1",
    "x-github-hook-installation-target-id": "101",
    "x-github-hook-installation-target-type": "integration",
    "x-hub-signature-256": `sha256=${hmacHex(appWebhookSecret(KEY, "101"), body)}`,
  });
  for (const [k, v] of Object.entries(over)) v === null ? h.delete(k) : h.set(k, v);
  return h;
};

const appA = makeApp("notation-achq", "101", { issues: "write", contents: "write", metadata: "read" });
const appB = makeApp("djgrant-claude", "202", { issues: "write", contents: "read", metadata: "read" });
const keys = { [appA.slug]: { id: appA.id, privateKey: appA.privateKey }, [appB.slug]: { id: appB.id, privateKey: appB.privateKey } };
const router = createGitHub({ apps: keys, key: KEY });
const { channel } = router;
const parse = (event: string, payload: object) => {
  const body = JSON.stringify(payload);
  return channel.parse("notation-achq", headers(event, body), body);
};

describe("verify", () => {
  const body = JSON.stringify(commentPayload("created"));

  test("accepts a delivery signed with its App's derived secret, naming that App", async () => {
    expect(await channel.verify(headers("issue_comment", body), body)).toBe("notation-achq");
    const b = headers("issue_comment", body, {
      "x-github-hook-installation-target-id": "202",
      "x-hub-signature-256": `sha256=${hmacHex(appWebhookSecret(KEY, "202"), body)}`,
    });
    expect(await channel.verify(b, body)).toBe("djgrant-claude");
  });

  test("rejects a wrong secret, another App's ID, an unknown App, a tampered body and missing headers", async () => {
    const wrong = `sha256=${hmacHex(appWebhookSecret("another-key", "101"), body)}`;
    expect(await channel.verify(headers("issue_comment", body, { "x-hub-signature-256": wrong }), body)).toBeUndefined();
    // Signed for App 101, but claims to be App 202: 202's secret doesn't check out.
    expect(await channel.verify(headers("issue_comment", body, { "x-github-hook-installation-target-id": "202" }), body)).toBeUndefined();
    const unknown = { "x-github-hook-installation-target-id": "999", "x-hub-signature-256": `sha256=${hmacHex(appWebhookSecret(KEY, "999"), body)}` };
    expect(await channel.verify(headers("issue_comment", body, unknown), body)).toBeUndefined();
    expect(await channel.verify(headers("issue_comment", body), body.replace("please", "PLEASE"))).toBeUndefined();
    expect(await channel.verify(headers("issue_comment", body, { "x-hub-signature-256": null }), body)).toBeUndefined();
    expect(await channel.verify(headers("issue_comment", body, { "x-github-hook-installation-target-id": null }), body)).toBeUndefined();
  });

  test("a container-side instance, without the key, verifies nothing", async () => {
    expect(await createGitHub({ apps: keys }).channel.verify(headers("issue_comment", body), body)).toBeUndefined();
  });
});

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

  test("push says whether any commit touched .achq/, by any kind of change", () => {
    expect(parse("push", push([{ modified: ["src/a.ts"] }]))!.detail.touchesConfig).toBe(false);
    expect(parse("push", push([{ modified: ["src/a.ts"] }, { removed: [".achq/Dockerfile"] }]))!.detail.touchesConfig).toBe(true);
    expect(parse("push", push([{ added: [".achq/config.ts"] }]))!.detail.touchesConfig).toBe(true);
    // Not a prefix match on the name alone.
    expect(parse("push", push([{ added: [".achqx/config.ts", "docs/.achq/x"] }]))!.detail.touchesConfig).toBe(false);
    const event = parse("push", push([], "refs/heads/feature"))!;
    expect(event.type).toBe("push");
    expect(event.repo).toBe("notationlabs/yieldstar");
    expect(event.detail).toMatchObject({ ref: "refs/heads/feature", defaultBranch: "main", after: "b".repeat(40), truncated: false });
  });

  test("a push listing GitHub's maximum of 2048 commits is marked truncated", () => {
    expect(parse("push", push(Array.from({ length: 2047 }, () => ({}))))!.detail.truncated).toBe(false);
    expect(parse("push", push(Array.from({ length: 2048 }, () => ({}))))!.detail.truncated).toBe(true);
  });

  test("installations list the repos added and removed, and the account", () => {
    const account = { login: "notationlabs", type: "Organization" };
    const created = parse("installation", {
      action: "created",
      installation: { id: 77, account },
      repositories: [{ id: 1, name: "a", full_name: "notationlabs/a", private: true }, { id: 2, name: "b", full_name: "notationlabs/b", private: false }],
      sender: user("dan"),
    })!;
    expect(created.type).toBe("installation.created");
    expect(created.repo).toBeUndefined();
    expect(created.detail).toEqual({ installation: 77, account: "notationlabs", repos: ["notationlabs/a", "notationlabs/b"], added: ["notationlabs/a", "notationlabs/b"], removed: [] });
    const deleted = parse("installation", { action: "deleted", installation: { id: 77, account }, repositories: [{ full_name: "notationlabs/a" }] })!;
    expect(deleted.detail).toMatchObject({ added: [], removed: ["notationlabs/a"] });
    expect(parse("installation", { action: "suspend", installation: { id: 77, account } })!.type).toBe("installation.suspend");
    const changed = parse("installation_repositories", {
      action: "removed",
      installation: { id: 77, account },
      repository_selection: "selected",
      repositories_added: [],
      repositories_removed: [{ id: 3, name: "c", full_name: "notationlabs/c" }],
    })!;
    expect(changed.type).toBe("installation_repositories.removed");
    expect(changed.detail).toMatchObject({ account: "notationlabs", added: [], removed: ["notationlabs/c"] });
    expect(parse("installation", { action: "new_permissions_accepted", installation: { id: 77, account } })).toBeUndefined();
  });
});

describe("matchEvent", () => {
  const selector = (over: Partial<EventSelectorData> = {}): EventSelectorData => ({
    channel: "github",
    source: "notation-achq",
    event: "issue_comment",
    actions: ["created", "edited"],
    mention: "@claude",
    ...over,
  });
  const comment = (action: string, over: Parameters<typeof commentPayload>[1] = {}) => parse("issue_comment", commentPayload(action, over))!;

  test("a new comment with the mention matches", () => {
    expect(channel.matchEvent(selector(), comment("created"))).toBe(true);
    expect(channel.matchEvent(selector(), comment("created", { body: "Thanks @Claude." }))).toBe(true);
  });

  test("an edit matches only when it adds the mention", () => {
    expect(channel.matchEvent(selector(), comment("edited", { body: "fix it @claude", from: "fix it" }))).toBe(true);
    expect(channel.matchEvent(selector(), comment("edited", { body: "@claude fix it now", from: "@claude fix it" }))).toBe(false);
    expect(channel.matchEvent(selector(), comment("edited", { body: "fix it", from: "@claude fix it" }))).toBe(false);
    // An issue whose title changed but whose body already mentioned it.
    const titleOnly = parse("issues", { action: "edited", issue: issuePayload({ body: "@claude" }), changes: { title: { from: "x" } }, repository })!;
    expect(channel.matchEvent(selector({ event: "issues", actions: ["edited"] }), titleOnly)).toBe(false);
    // An edit event without a previous text can't show the mention is new.
    const { previousText, ...noPrevious } = comment("edited", { body: "@claude", from: "" });
    expect(channel.matchEvent(selector(), noPrevious as ChannelEvent)).toBe(false);
  });

  test("a mention inside a longer name or an address doesn't count", () => {
    expect(mentions("@claudette help", "@claude")).toBe(false);
    expect(mentions("mail me@claude.ai", "@claude")).toBe(false);
    expect(mentions("@claude-bot", "@claude")).toBe(false);
    expect(mentions("(@claude)", "@claude")).toBe(true);
    expect(channel.matchEvent(selector(), comment("created", { body: "no mention here" }))).toBe(false);
  });

  test("actions, event, labels and source must all match", () => {
    expect(channel.matchEvent(selector({ actions: ["created"] }), comment("edited", { body: "@claude", from: "" }))).toBe(false);
    expect(channel.matchEvent(selector({ event: "issues" }), comment("created"))).toBe(false);
    expect(channel.matchEvent(selector({ labels: ["docs"] }), comment("created"))).toBe(true);
    expect(channel.matchEvent(selector({ labels: ["docs", "bug"] }), comment("created"))).toBe(false);
    expect(channel.matchEvent(selector({ source: "djgrant-claude" }), comment("created"))).toBe(false);
    expect(channel.matchEvent({ ...selector(), channel: "linear" } as any, comment("created"))).toBe(false);
  });

  test("bots and untrusted actors never match", () => {
    expect(channel.matchEvent(selector(), comment("created", { author: "x[bot]", type: "Bot", association: "OWNER" }))).toBe(false);
    expect(channel.matchEvent(selector(), comment("created", { association: "CONTRIBUTOR" }))).toBe(false);
    expect(channel.matchEvent(selector(), comment("created", { issue: issuePayload({ association: "NONE" }) }))).toBe(false);
  });

  test("issue events, with no mention required", () => {
    const opened = parse("issues", { action: "opened", issue: issuePayload(), repository })!;
    expect(channel.matchEvent({ channel: "github", source: "notation-achq", event: "issues", actions: ["opened"] }, opened)).toBe(true);
    expect(channel.matchEvent({ channel: "github", source: "notation-achq", event: "issues", actions: ["reopened"] }, opened)).toBe(false);
  });

  test("a push or a thread selector never matches as an event", () => {
    const push = parse("push", { ref: "refs/heads/main", commits: [], repository, after: "x" })!;
    expect(channel.matchEvent(selector({ event: "push" as any, actions: [] }), push)).toBe(false);
    expect(channel.matchEvent({ channel: "github", source: "notation-achq", kind: "issue" }, comment("created"))).toBe(false);
  });
});

describe("matchThread", () => {
  const ref = { channel: "github", id: "o/r#1" };
  const sel = (labels?: string[]): IssueSelectorData => ({ channel: "github", source: "notation-achq", kind: "issue", ...(labels && { labels }) });
  test("needs every selector label", () => {
    expect(channel.matchThread(sel(), { ref, labels: [] })).toBe(true);
    expect(channel.matchThread(sel(["docs"]), { ref, labels: ["docs", "bug"] })).toBe(true);
    expect(channel.matchThread(sel(["docs", "x"]), { ref, labels: ["docs"] })).toBe(false);
    expect(channel.matchThread(sel(), { ref: { channel: "linear", id: "ENG-1" }, labels: [] })).toBe(false);
    expect(channel.matchThread({ channel: "github", source: "notation-achq", event: "issues", actions: ["opened"] }, { ref, labels: [] })).toBe(false);
  });
});

describe("helpers", () => {
  test("message IDs sort chronologically as strings, the opening post first", () => {
    const ids = [10, 9, 100, 4_000_000_000, 1].map(messageId);
    expect([...ids, messageId(null)].sort()).toEqual([messageId(null), ...[1, 9, 10, 100, 4_000_000_000].map(messageId)]);
    expect(messageId(10) > messageId(9)).toBe(true);
  });

  test("slugify", () => {
    expect(slugify("Fix: the Café's  broken (login) flow!")).toBe("fix-the-cafe-s-broken-login-flow");
    expect(slugify("a".repeat(39) + " bcd").length).toBeLessThanOrEqual(40);
    expect(slugify("a".repeat(39) + " bcd").endsWith("-")).toBe(false);
  });
});

// ─── Against a fake GitHub API ───

describe("against GitHub", () => {
  const gh = new FakeGitHub([appA, appB]);
  let api: ReturnType<typeof createGitHub>;
  const repo = "notationlabs/yieldstar";

  beforeAll(() => {
    gh.start();
    api = createGitHub({ apps: gh.keys(), key: KEY, baseUrl: gh.url });
    gh.installations.push({ id: 77, app: appA.slug, account: "notationlabs", permissions: appA.permissions, repos: [repo, "notationlabs/shared"] });
    gh.users.set("notation-achq[bot]", { id: 555, login: "notation-achq[bot]" });
    gh.addIssue(repo, { number: 42, title: "Fix the login flow, please!", body: "It's broken", labels: [{ name: "docs" }] });
    // Out of creation order on purpose, and more than one page.
    gh.addComment(repo, 42, { id: 10, body: "ten" });
    gh.addComment(repo, 42, { id: 9, body: "nine", user: { login: "eve", type: "User" }, author_association: "NONE" });
    for (let i = 0; i < 120; i++) gh.addComment(repo, 42, { id: 1000 + i, body: `c${i}` });
    gh.addComment(repo, 42, { id: 5000, body: "earlier reply", user: { login: "notation-achq[bot]", type: "Bot" }, author_association: "NONE" });
  });
  afterAll(() => gh.stop());

  test("mintClient asks for a token on just this repo, with the runner's permissions", async () => {
    const credential = await api.channel.mintClient("notation-achq", repo);
    expect(gh.minted.at(-1)).toEqual({ installation: 77, body: { repositories: ["yieldstar"], permissions: { issues: "write", contents: "read", metadata: "read" } } });
    expect(credential.scope).toMatchObject({ app: "notation-achq", repos: [repo], permissions: { issues: "write", contents: "read", metadata: "read" } });
    expect(credential.expiresAt).toBe("2026-10-18T13:00:00Z");
    await expect(api.channel.mintClient("djgrant-claude", repo)).rejects.toThrow(/isn't installed/);
  });

  test("the client reads the thread and its messages in order, and knows its own and trusted ones", async () => {
    const client = api.channel.client(await api.channel.mintClient("notation-achq", repo));
    const ref = { channel: "github", id: `${repo}#42` };
    const thread = await client.thread(ref);
    expect(thread).toEqual({
      ref,
      title: "Fix the login flow, please!",
      url: `https://github.com/${repo}/issues/42`,
      labels: ["docs"],
      vars: { number: "42", title: "fix-the-login-flow-please", owner: "notationlabs", repo: "yieldstar" },
    });
    const messages = await client.messages(ref);
    expect(messages.length).toBe(1 + 2 + 120 + 1);
    expect(messages[0]).toMatchObject({ id: messageId(null), body: "It's broken", trusted: true, own: false });
    expect(messages.slice(1, 3).map((m) => m.body)).toEqual(["nine", "ten"]);
    expect(messages[1]!.trusted).toBe(false);
    expect(messages.at(-1)).toMatchObject({ body: "earlier reply", own: true, trusted: false });
    const ids = messages.map((m) => m.id);
    expect([...ids].sort()).toEqual(ids);
    // What the container does: keep what's newer than the last seen.
    expect(messages.filter((m) => m.id > messageId(10)).length).toBe(121);
  });

  test("reply, acknowledge and identity", async () => {
    const client = api.channel.client(await api.channel.mintClient("notation-achq", repo));
    const ref = { channel: "github", id: `${repo}#42` };
    await client.reply(ref, "Done.");
    const issue = gh.issues.get(`${repo}#42`)!;
    expect(issue.comments.at(-1)).toMatchObject({ body: "Done.", user: { login: "notation-achq[bot]" } });
    const base = { channel: "github", source: "notation-achq", delivery: "d", repo, thread: ref };
    await client.acknowledge({ ...base, type: "issue_comment.created", detail: { issue: 42, comment: 10 } });
    await client.acknowledge({ ...base, type: "issues.opened", detail: { issue: 42 } });
    expect(issue.reactions).toEqual(["comment:10:eyes", "issue:eyes"]);
    expect(await client.identity()).toEqual({ name: "notation-achq[bot]", email: "555+notation-achq[bot]@users.noreply.github.com" });
  });

  test("the client's token doesn't reach other repos", async () => {
    gh.addIssue("notationlabs/shared", { number: 1 });
    const client = api.channel.client(await api.channel.mintClient("notation-achq", repo));
    await expect(client.thread({ channel: "github", id: "notationlabs/shared#1" })).rejects.toThrow(/404/);
  });
});
