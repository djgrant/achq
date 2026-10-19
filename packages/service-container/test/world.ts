import { afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type ChannelEvent, threadKey } from "@achq/core";
import { signedHeaders } from "@achq/core/signing";
import { fakeRouter } from "@achq/test-utils/container-router";
import { fakeClaude } from "@achq/test-utils/fake-claude";
import { makeOrigin } from "@achq/test-utils/origin";
import { testAccess } from "@achq/test-utils/test-access";
import { tempDir } from "@achq/test-utils/temp-dir";
import { TestChannel } from "@achq/test-utils/test-channel";
import { createConfigLoader } from "../src/config/loader.ts";
import { paths as layout } from "../src/paths.ts";
import { fetchMirror } from "../src/repo.ts";
import { Runner } from "../src/runner.ts";
import { readState } from "../src/state.ts";

export const dirs: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

export const SECRET = "the-container-secret";

/** A runner wired to a real git origin, a fake claude, a fake router and the test channel. */
export const world = async (opts: { maxRuns?: number } = {}) => {
  const root = tempDir(dirs);
  const git = await makeOrigin(root);
  const claude = fakeClaude(root);
  const router = fakeRouter(SECRET);
  cleanups.push(router.stop);
  const channel = new TestChannel();
  const dataDir = path.join(root, "data");
  const paths = layout(dataDir);
  const load = createConfigLoader({ mirror: paths.mirror, dir: paths.config, fetch: () => fetchMirror(paths.mirror, git.origin) });
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    FAKE_CLAUDE_LOG: claude.log,
    ACHQ_CONTAINER_SECRET: SECRET,
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
    ACHQ_CLAUDE_BIN: claude.bin,
  };
  const logs: string[] = [];
  const runner = new Runner({
    repo: "acme/widgets",
    container: "dev",
    channels: [channel],
    access: [testAccess()],
    routerUrl: router.url,
    containerSecret: SECRET,
    dataDir,
    repoUrl: git.origin,
    loadConfig: (commit) => load(commit ?? git.first),
    env,
    maxRuns: opts.maxRuns,
    keepAwake: async () => {},
    log: (line) => logs.push(line),
  });
  /** POSTs a signed event and waits for everything it started. */
  const send = async (event: ChannelEvent, commit = git.first) => {
    const res = await post(JSON.stringify({ event, commit }));
    await runner.idle();
    return res.status;
  };
  const post = (body: string, headers: Record<string, string> = signedHeaders(SECRET, "POST", "/events", body)) =>
    runner.fetch(new Request("http://container/events", { method: "POST", body, headers }));
  const state = (n: number) => readState(paths.thread(threadKey(channel.ref(n))))!;
  return { root, git, claude, router, channel, paths, env, runner, send, post, state, logs, load };
};
