import { beforeEach, describe, expect, test } from "bun:test";
import * as claude from "@achq/claude";
import * as github from "@achq/github";
import { collectManifest, Container, declared, resetDeclarations, Trigger, Workspace } from "@achq/core";

beforeEach(resetDeclarations);

describe("collectManifest", () => {
  test("turns the design doc's repo config into a manifest, in declaration order", () => {
    const channel = github.Channel.get("notation-achq");
    const code = new github.Policy("code", { channel, permissions: { contents: "write", issues: "write" } });
    const dev = new Container("dev", { image: "./Dockerfile", policies: [code], files: { "~/.config/foo.toml": "./foo.toml" } });
    new Workspace("docs", { container: dev, threads: channel.issues.where({ labels: ["docs"] }), branch: "docs/{number}", base: "docs" });
    new Workspace("issues", { container: dev, threads: channel.issues, branch: "issue-{number}", base: "main" });
    const coder = new claude.Agent("coder", { model: "claude-opus-5-5", settings: { computed: [1, 2].map((n) => n * 2) } });
    new Trigger("mention", { event: channel.issueComment({ actions: ["created", "edited"], mention: "@claude" }), agent: coder });

    expect(collectManifest()).toEqual({
      policies: [{ name: "code", policy: { provider: "github", source: "notation-achq", repo: null, permissions: { contents: "write", issues: "write" } } }],
      containers: [{ name: "dev", image: "./Dockerfile", policies: ["code"], files: { "~/.config/foo.toml": "./foo.toml" } }],
      workspaces: [
        { name: "docs", container: "dev", threads: { channel: "github", source: "notation-achq", kind: "issue", labels: ["docs"] }, branch: "docs/{number}", base: "docs" },
        { name: "issues", container: "dev", threads: { channel: "github", source: "notation-achq", kind: "issue" }, branch: "issue-{number}", base: "main" },
      ],
      agents: [{ name: "coder", runtime: "claude" }],
      triggers: [
        { name: "mention", event: { channel: "github", source: "notation-achq", event: "issue_comment", actions: ["created", "edited"], mention: "@claude" }, agent: "coder" },
      ],
    });
  });

  test("where() narrows without changing the selector it came from", () => {
    const channel = github.Channel.get("a");
    const docs = channel.issues.where({ labels: ["docs"] });
    expect(docs.where({ labels: ["urgent"] }).data.labels).toEqual(["docs", "urgent"]);
    expect(channel.issues.data.labels).toBeUndefined();
  });

  test("rejects duplicate names within a kind, but not across kinds", () => {
    new Container("dev", { image: "./Dockerfile" });
    new claude.Agent("dev", {});
    expect(() => collectManifest()).not.toThrow();
    new Container("dev", { image: "./Other" });
    expect(() => collectManifest()).toThrow('Two containers are named "dev"');
  });

  test("rejects references to resources from another config", () => {
    const stray = new Container("stray", { image: "./Dockerfile" });
    const channel = github.Channel.get("a");
    resetDeclarations();
    new Container("dev", { image: "./Dockerfile" });
    new Workspace("w", { container: stray, threads: channel.issues, branch: "b", base: "main" });
    expect(() => collectManifest()).toThrow('workspace w refers to container "stray"');
  });

  test("rejects non-data in files, and bad names", () => {
    new Container("dev", { image: "./Dockerfile", files: { x: { when: new Date() } as never } });
    expect(() => collectManifest()).toThrow("container dev files.x.when is not plain data");
    expect(() => new Container("Dev", { image: "x" })).toThrow("must be lowercase");
  });

  test("needs at least one container", () => {
    expect(declared()).toEqual([]);
    expect(() => collectManifest()).toThrow("no containers");
  });
});
