// A subscriber repo's .achq/config.ts: one container, two workspaces, two agents.

import { Container, Trigger, Workspace } from "./primitives.ts";
import { Claude, GitHubApp, RepoPolicy } from "./example-providers.ts";

const app = GitHubApp.get("notation-achq");

const code = new RepoPolicy("code", { app, permissions: { contents: "write", issues: "write", pull_requests: "write" } });
const shared = new RepoPolicy("shared", { app, repo: "notationlabs/shared", permissions: { contents: "read" } });

const dev = new Container("dev", {
  image: "./Dockerfile",
  policies: [code, shared],
  files: { "~/.config/pnpm/rc": "./pnpmrc" },
});

new Workspace("docs", { container: dev, threads: app.issues.where({ labels: ["docs"] }), branch: "docs/{number}", base: "docs" });
new Workspace("issues", { container: dev, threads: app.issues, branch: "issue-{number}", base: "main" });

const coder = new Claude("coder", {
  model: "claude-opus-5-5",
  effort: "high",
  systemPrompt: "./prompts/system.md",
  prompts: { new: "./prompts/new.md", resume: "./prompts/resume.md" },
  settings: { permissions: { deny: ["Bash(curl:*)"] } },
  instructions: "./claude.md",
});

const triage = new Claude("triage", { model: "claude-haiku-5-5", systemPrompt: "./prompts/triage.md" });

new Trigger("mention", { event: app.issueComment({ actions: ["created", "edited"], mention: "@claude" }), agent: coder });
new Trigger("mention-in-body", { event: app.issue({ actions: ["opened", "edited"], mention: "@claude" }), agent: coder });
new Trigger("triage", { event: app.issue({ actions: ["opened"] }), agent: triage });
