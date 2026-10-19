import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appWebhookSecret } from "../src/lib/webhook-secret.ts";
import { hmacHex } from "@achq/core/signing";
import { FakeGitHub } from "@achq/test-utils/github";
import { githubChannel } from "../src/channels/index.ts";
import type { GitHubChannel } from "../src/channels/channel.ts";
import { messageId } from "../src/channels/messages.ts";
import { appA, appB, channel, commentPayload, githubEnv, headers, KEY, keys } from "./payloads.ts";

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
    expect(await githubChannel.create(githubEnv(keys)).verify(headers("issue_comment", body), body)).toBeUndefined();
  });
});

// ─── Against a fake GitHub API ───

describe("against GitHub", () => {
  const gh = new FakeGitHub([appA, appB]);
  let api: { channel: GitHubChannel };
  const repo = "notationlabs/yieldstar";

  beforeAll(() => {
    gh.start();
    api = { channel: githubChannel.create(githubEnv(gh.keys(), gh.url), KEY) as GitHubChannel };
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
    expect(credential.scope).toMatchObject({ source: "notation-achq", app: "notation-achq", repos: [repo], permissions: { issues: "write", contents: "read", metadata: "read" } });
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
