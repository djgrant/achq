// The design doc's repo config, split across files the way a repo would.
export const DOC_CONFIG = {
  "config.ts": `
import { Container, Workspace, Trigger } from "achq";
import * as github from "achq/github";
import { coder, triage } from "./agents.ts";

const channel = github.Channel.get("notation-achq");

const code = new github.Policy("code", { channel, permissions: { contents: "write", issues: "write", pull_requests: "write" } });

const dev = new Container("dev", {
  image: "./Dockerfile",
  policies: [code],
  files: { "~/.config/foo.toml": "./foo.toml" },
});

new Workspace("docs", { container: dev, threads: channel.issues.where({ labels: ["docs"] }), branch: "docs/{number}", base: "docs" });
new Workspace("issues", { container: dev, threads: channel.issues, branch: "issue-{number}", base: "main" });

new Trigger("mention", { event: channel.issueComment({ actions: ["created", "edited"], mention: "@claude" }), agent: coder });
new Trigger("triage", { event: channel.issue({ actions: ["opened"] }), agent: triage });
`,
  "agents.ts": `
import { Claude } from "achq";
export const coder = new Claude("coder", { model: "claude-opus-5-5", effort: "high", systemPrompt: "./prompts/system.md", settings: { hooks: [1, 2].map((n) => n * 2) } });
export const triage = new Claude("triage", { model: "claude-haiku-5-5", systemPrompt: "./prompts/triage.md" });
`,
};

export const DOC_PLAN = {
  policies: [{ name: "code", policy: { provider: "github", source: "notation-achq", repo: null, permissions: { contents: "write", issues: "write", pull_requests: "write" } } }],
  containers: [{ name: "dev", image: "./Dockerfile", policies: ["code"], files: { "~/.config/foo.toml": "./foo.toml" } }],
  workspaces: [
    { name: "docs", container: "dev", threads: { channel: "github", source: "notation-achq", kind: "issue", labels: ["docs"] }, branch: "docs/{number}", base: "docs" },
    { name: "issues", container: "dev", threads: { channel: "github", source: "notation-achq", kind: "issue" }, branch: "issue-{number}", base: "main" },
  ],
  agents: [
    { name: "coder", runtime: "claude" },
    { name: "triage", runtime: "claude" },
  ],
  triggers: [
    { name: "mention", event: { channel: "github", source: "notation-achq", event: "issue_comment", actions: ["created", "edited"], mention: "@claude" }, agent: "coder" },
    { name: "triage", event: { channel: "github", source: "notation-achq", event: "issues", actions: ["opened"] }, agent: "triage" },
  ],
};
