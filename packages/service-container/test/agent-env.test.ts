import { expect, test } from "bun:test";
import { withoutPrivate } from "../src/agent-env.ts";

test("agents never get achq's private variables, or the ones ACHQ_PRIVATE_ENV names", () => {
  const env = {
    PATH: "/bin",
    ACHQ_CONTAINER_SECRET: "s",
    AGENT_WEBHOOK_KEY: "k",
    ACHQ_PRIVATE_ENV: "RAILWAY_TOKEN, ACHQ_GITHUB_APPS,",
    RAILWAY_TOKEN: "r",
    ACHQ_GITHUB_APPS: "{}",
    CLAUDE_CODE_OAUTH_TOKEN: "c",
  };
  expect(withoutPrivate(env)).toEqual({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "c" });
});
