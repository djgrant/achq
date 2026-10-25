import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as claude from "@achq/claude";
import { makeOrigin } from "@achq/test-utils/fixtures/origin";
import { tempDir } from "@achq/test-utils/helpers/temp-dir";
import { bundleConfig, createConfigLoader, evaluateBundle } from "../src/features/config.ts";
import { paths as layout } from "../src/features/layout.ts";
import { fetchMirror } from "../src/features/repo.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  test("bundles and imports a multi-file .achq/ from a commit, with agent settings computed in code", async () => {
    const root = tempDir(dirs);
    const git = await makeOrigin(root);
    const paths = layout(path.join(root, "data"));
    let fetches = 0;
    const load = createConfigLoader({ mirror: paths.mirror, dir: paths.config, fetch: () => (fetches++, fetchMirror(paths.mirror, git.origin)) });

    const config = await load(git.first);
    expect(config.manifest.containers).toEqual([{ name: "dev", image: "./Dockerfile", policies: [], files: { "~/.config/tool.toml": "./tool.toml" } }]);
    expect(config.manifest.workspaces.map((w) => [w.name, w.branch, w.base])).toEqual([["docs", "docs/{number}", "docs"], ["issues", "issue-{number}", "main"]]);
    expect(config.manifest.triggers.map((t) => t.agent)).toEqual(["coder", "triage", "coder"]);
    const coder = config.agents.find((a) => a.name === "coder")!;
    expect(coder).toBeInstanceOf(claude.Agent);
    expect((coder as claude.Agent).config.settings).toEqual({ env: { AGENT: "CODER" }, permissions: { deny: ["Read(./secrets/**)", "Read(./keys/**)"] } });
    expect(fs.readFileSync(path.join(config.root, "prompts/coder.md"), "utf8")).toBe("You are the coder.\n");
    expect(await load(git.first)).toBe(config);

    // Another commit is another config, fetched on demand.
    const { after: next } = await git.commit({ ".achq/lib/settings.ts": `export const settingsFor = (name: string) => ({ n: name.length * 2 });\n` });
    const changed = await load(next);
    expect((changed.agents.find((a) => a.name === "coder") as claude.Agent).config.settings).toEqual({ n: 10 });
    expect(fetches).toBe(2);
    expect(((await load(git.first)).agents[0] as claude.Agent).config.settings).toEqual({ env: { AGENT: "CODER" }, permissions: { deny: ["Read(./secrets/**)", "Read(./keys/**)"] } });
    await expect(load("0".repeat(40))).rejects.toThrow("isn't in the repo");
  });

  test("refuses imports other than achq and its own files", async () => {
    const root = tempDir(dirs);
    const achq = path.join(root, ".achq");
    fs.mkdirSync(achq);
    fs.writeFileSync(path.join(root, "outside.ts"), "export const x = 1;\n");
    for (const [source, message] of [
      [`import * as fs from "node:fs"; fs.readFileSync("/etc/passwd");`, `not "fs"`],
      [`import { x } from "../outside.ts"; console.log(x);`, "its own files"],
    ]) {
      fs.writeFileSync(path.join(achq, "config.ts"), source!);
      await expect(bundleConfig(achq, path.join(root, "out"))).rejects.toThrow();
      const err = await bundleConfig(achq, path.join(root, "out")).catch((e) => e);
      expect(String(err.errors?.map(String) ?? err)).toContain(message);
    }
  });

  test("a config that declares nothing runnable fails", async () => {
    const root = tempDir(dirs);
    const achq = path.join(root, ".achq");
    fs.mkdirSync(achq);
    fs.writeFileSync(path.join(achq, "config.ts"), `import * as claude from "achq/claude"; new claude.Agent("a", {});`);
    await expect(evaluateBundle(await bundleConfig(achq, path.join(root, "out")))).rejects.toThrow("no containers");
  });
});
