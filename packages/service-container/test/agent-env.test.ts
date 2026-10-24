import { expect, test } from "bun:test";
import { CHANNEL_PROVIDERS, CODE_HOST, CONTAINER_PROVIDERS, POLICY_PROVIDERS } from "achq/registry";
import { withoutPrivate } from "../src/agent-env.ts";

test("agents never get the container secret, the key, or any implementation's private variables", () => {
  const env = {
    PATH: "/bin",
    ACHQ_CONTAINER_SECRET: "s",
    AGENT_WEBHOOK_KEY: "k",
    RAILWAY_API_TOKEN: "r",
    ACHQ_GITHUB_APPS: "{}",
    CLOUDFLARE_API_TOKEN: "c",
    CLAUDE_CODE_OAUTH_TOKEN: "c",
  };
  expect(withoutPrivate(env)).toEqual({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "c" });

  const everyPrivate = [...CHANNEL_PROVIDERS, ...POLICY_PROVIDERS, CODE_HOST, ...CONTAINER_PROVIDERS].flatMap((i) => i.privateEnv);
  expect(everyPrivate.length).toBeGreaterThan(0);
  expect(withoutPrivate(Object.fromEntries(everyPrivate.map((name) => [name, "x"])))).toEqual({});
});
