import { beforeEach, describe, expect, test } from "bun:test";
import { Claude } from "@achq/claude";
import * as github from "@achq/github";
import { collectPlan, Container, registered, resetRegistry, Trigger, Workspace } from "@achq/core";

beforeEach(resetRegistry);

describe("collectPlan", () => {
  test("turns the design doc's repo config into a plan, in declaration order", () => {
    const app = github.App.get("notation-achq");
    const code = new github.RepoPolicy("code", { app, permissions: { contents: "write", issues: "write" } });
    const dev = new Container("dev", { image: "./Dockerfile", policies: [code], files: { "~/.config/foo.toml": "./foo.toml" } });
    new Workspace("docs", { container: dev, threads: app.issues.where({ labels: ["docs"] }), branch: "docs/{number}", base: "docs" });
    new Workspace("issues", { container: dev, threads: app.issues, branch: "issue-{number}", base: "main" });
    const coder = new Claude("coder", { model: "claude-opus-5-5", settings: { computed: [1, 2].map((n) => n * 2) } });
    new Trigger("mention", { event: app.issueComment({ actions: ["created", "edited"], mention: "@claude" }), agent: coder });

    expect(collectPlan()).toEqual({
      policies: [{ name: "code", policy: { access: "github", app: "notation-achq", repo: null, permissions: { contents: "write", issues: "write" } } }],
      containers: [{ name: "dev", image: "./Dockerfile", policies: ["code"], files: { "~/.config/foo.toml": "./foo.toml" } }],
      workspaces: [
        { name: "docs", container: "dev", threads: { channel: "github", source: "notation-achq", kind: "issue", labels: ["docs"] }, branch: "docs/{number}", base: "docs" },
        { name: "issues", container: "dev", threads: { channel: "github", source: "notation-achq", kind: "issue" }, branch: "issue-{number}", base: "main" },
      ],
      agents: [{ name: "coder", kind: "claude" }],
      triggers: [
        { name: "mention", event: { channel: "github", source: "notation-achq", event: "issue_comment", actions: ["created", "edited"], mention: "@claude" }, agent: "coder" },
      ],
    });
  });

  test("where() narrows without changing the selector it came from", () => {
    const app = github.App.get("a");
    const docs = app.issues.where({ labels: ["docs"] });
    expect(docs.where({ labels: ["urgent"] }).data.labels).toEqual(["docs", "urgent"]);
    expect(app.issues.data.labels).toBeUndefined();
  });

  test("rejects duplicate names within a kind, but not across kinds", () => {
    new Container("dev", { image: "./Dockerfile" });
    new Claude("dev", {});
    expect(() => collectPlan()).not.toThrow();
    new Container("dev", { image: "./Other" });
    expect(() => collectPlan()).toThrow('Two containers are named "dev"');
  });

  test("rejects references to resources from another config", () => {
    const stray = new Container("stray", { image: "./Dockerfile" });
    const app = github.App.get("a");
    resetRegistry();
    new Container("dev", { image: "./Dockerfile" });
    new Workspace("w", { container: stray, threads: app.issues, branch: "b", base: "main" });
    expect(() => collectPlan()).toThrow('workspace w refers to container "stray"');
  });

  test("rejects non-data in files, and bad names", () => {
    new Container("dev", { image: "./Dockerfile", files: { x: { when: new Date() } as never } });
    expect(() => collectPlan()).toThrow("container dev files.x.when is not plain data");
    expect(() => new Container("Dev", { image: "x" })).toThrow("must be lowercase");
  });

  test("needs at least one container", () => {
    expect(registered()).toEqual([]);
    expect(() => collectPlan()).toThrow("no containers");
  });
});
