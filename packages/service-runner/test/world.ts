import { afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type ChannelEvent, privateEnv, threadKey } from "@achq/core";
import { providers as claudePlugin } from "@achq/claude/providers";
import { signedHeaders } from "@achq/core/signing";
import { fakeRouter } from "@achq/test-utils/fakes/achq/router-container";
import { fakeClaude } from "@achq/test-utils/fakes/vendors/claude";
import { makeOrigin } from "@achq/test-utils/fixtures/origin";
import { testPolicyProvider } from "@achq/test-utils/fakes/achq/policy-provider";
import { workspaceConfigModules } from "@achq/test-utils/helpers/plugins";
import { tempDir } from "@achq/test-utils/helpers/temp-dir";
import { TestChannelProvider } from "@achq/test-utils/fakes/achq/channel-provider";
import { Env } from "@achq/utils/env";
import { runLimits } from "../src/from-env.ts";
import { createConfigLoader } from "../src/features/config.ts";
import { fetchMirror } from "../src/features/repo.ts";
import { Runner } from "../src/features/runner.ts";
import { paths as layout } from "../src/features/layout.ts";
import { routes } from "../src/routes.ts";
import { driversOf } from "../src/features/driver-context.ts";
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
  const channel = new TestChannelProvider();
  const dataDir = path.join(root, "data");
  const paths = layout(dataDir);
  const load = createConfigLoader({ modules: workspaceConfigModules(), mirror: paths.mirror, dir: paths.config, fetch: () => fetchMirror(paths.mirror, git.origin) });
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    FAKE_CLAUDE_LOG: claude.log,
    ACHQ_CONTAINER_SECRET: SECRET,
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
    ACHQ_CLAUDE_BIN: claude.bin,
  };
  const logs: string[] = [];
  // As the container loads them from its plugins: the test channel and policy provider, and Claude.
  const loaded = { drivers: driversOf(claudePlugin.agents!), privateEnv: privateEnv(claudePlugin) };
  const runner = new Runner({
    repo: "acme/widgets",
    container: "dev",
    channelProviders: [channel],
    policyProviders: [testPolicyProvider()],
    routerUrl: router.url,
    containerSecret: SECRET,
    dataDir,
    repoUrl: git.origin,
    loadConfig: load,
    ...loaded,
    env,
    ...runLimits(new Env(env)),
    ...(opts.maxRuns && { maxRuns: opts.maxRuns }),
    keepAwake: async () => {},
    log: (line) => logs.push(line),
  });
  const { fetch } = routes(runner);
  /** POSTs a signed event, as the router does for `workspace`, and waits for everything it started. */
  const send = async (event: ChannelEvent, commit = git.first, workspace = "issues") => {
    const res = await post(JSON.stringify({ event, commit, workspace }));
    await runner.idle();
    return res.status;
  };
  const post = (body: string, headers: Record<string, string> = signedHeaders(SECRET, "POST", "/events", body)) =>
    fetch(new Request("http://container/events", { method: "POST", body, headers: { ...headers, "content-type": "application/json" } }));
  const state = (n: number) => readState(paths.thread(threadKey(channel.ref(n))))!;
  return { root, git, claude, loaded, router, channel, paths, env, runner, send, post, state, logs, load };
};
