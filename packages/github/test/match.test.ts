import { describe, expect, test } from "bun:test";
import type { ChannelEvent } from "@achq/core";
import type { EventSelectorData, IssueSelectorData } from "../src/resources/index.ts";
import { mentions } from "../src/runtime/mentions.ts";
import { channel, commentPayload, issuePayload, parse, repository } from "./payloads.ts";

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
