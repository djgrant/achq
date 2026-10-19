import { $ } from "bun";
import * as fs from "node:fs";
import * as path from "node:path";

export const CONFIG = `
import { Container, EventSelector, ThreadSelector, Trigger, Workspace } from "achq";
import * as claude from "achq/claude";
import { settingsFor } from "./lib/settings.ts";

const dev = new Container("dev", { image: "./Dockerfile", files: { "~/.config/tool.toml": "./tool.toml" } });
new Workspace("docs", { container: dev, threads: new ThreadSelector({ channel: "test", labels: ["docs"] }), branch: "docs/{number}", base: "docs" });
new Workspace("issues", { container: dev, threads: new ThreadSelector({ channel: "test" }), branch: "issue-{number}", base: "main" });

const coder = new claude.Agent("coder", { model: "claude-opus-5-5", effort: "high", systemPrompt: "./prompts/coder.md", settings: settingsFor("coder") });
const triage = new claude.Agent("triage", { model: "claude-haiku-5-5", effort: "max", systemPrompt: "./prompts/triage.md" });

new Trigger("mention", { event: new EventSelector({ channel: "test", type: "comment", mention: "@claude" }), agent: coder });
new Trigger("triage", { event: new EventSelector({ channel: "test", type: "opened" }), agent: triage });
new Trigger("kickoff", { event: new EventSelector({ channel: "test", type: "opened" }), agent: coder });
`;

export const CONFIG_FILES: Record<string, string> = {
  ".achq/config.ts": CONFIG,
  ".achq/lib/settings.ts": `
const deny = ["secrets", "keys"].map((dir) => \`Read(./\${dir}/**)\`);
export const settingsFor = (name: string) => ({ env: { AGENT: name.toUpperCase() }, permissions: { deny } });
`,
  ".achq/prompts/coder.md": "You are the coder.\n",
  ".achq/prompts/triage.md": "You are the triager.\n",
  ".achq/tool.toml": "level = 1\n",
  ".achq/Dockerfile": "FROM oven/bun\n",
};

/** A bare repo with `files` on main and `docs` on a `docs` branch, and a way to push more commits. */
export const makeOrigin = async (root: string, files: Record<string, string> = CONFIG_FILES, docs: Record<string, string> = { "docs.txt": "docs branch\n" }) => {
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  await $`git init -q --bare -b main ${origin}`.quiet();
  await $`git init -q -b main ${seed}`.quiet();
  const git = (...args: string[]) => $`git -C ${seed} -c user.name=t -c user.email=t@t ${args}`.quiet();
  const write = (files: Record<string, string>) => {
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
      fs.writeFileSync(path.join(seed, file), content);
    }
  };
  write({ ...files, "README.md": "main\n" });
  await git("add", "-A");
  await git("commit", "-qm", "init");
  await git("checkout", "-qb", "docs");
  write(docs);
  await git("add", "-A");
  await git("commit", "-qm", "docs");
  await git("push", "-q", origin, "main", "docs");
  await git("checkout", "-q", "main");
  const head = async () => (await $`git -C ${seed} rev-parse HEAD`.quiet().text()).trim();
  return {
    origin,
    first: await head(),
    /** Commits on main and pushes; returns the commit and its parent. */
    async commit(files: Record<string, string>, message = "change") {
      const before = await head();
      write(files);
      await git("add", "-A");
      await git("commit", "-qm", message);
      await git("push", "-q", origin, "main");
      return { before, after: await head() };
    },
  };
};
