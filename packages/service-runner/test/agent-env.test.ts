import { expect, test } from "bun:test";
import { mergeProviders, privateEnv } from "@achq/core";
import { providers as claude } from "@achq/claude/providers";
import { providers as github } from "@achq/github/providers";
import { withoutPrivate } from "../src/features/agent-env.ts";

test("agents never get the container secret, the key, or any loaded implementation's private variables", () => {
  const loaded = mergeProviders([github, claude]);
  const env = {
    PATH: "/bin",
    ACHQ_CONTAINER_SECRET: "s",
    AGENT_WEBHOOK_KEY: "k",
    ACHQ_GITHUB_APPS: "{}",
    CLAUDE_CODE_OAUTH_TOKEN: "c",
  };
  expect(withoutPrivate(env, privateEnv(loaded))).toEqual({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "c" });

  const everyPrivate = [...loaded.channels, ...loaded.policies, ...loaded.codeHosts].flatMap((i) => i.privateEnv);
  expect(everyPrivate.length).toBeGreaterThan(0);
  expect(withoutPrivate(Object.fromEntries(everyPrivate.map((name) => [name, "x"])), privateEnv(loaded))).toEqual({});
});
