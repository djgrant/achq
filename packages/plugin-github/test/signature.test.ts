import { expect, test } from "bun:test";
import { appWebhookSecret } from "../src/lib/apps.ts";
import { hmacHex } from "@achq/core/signing";
import { verifyGitHubSignature } from "../src/lib/webhooks.ts";

test("GitHub signatures", () => {
  const s = appWebhookSecret("k", 42);
  const body = '{"action":"created"}';
  expect(verifyGitHubSignature(s, body, `sha256=${hmacHex(s, body)}`)).toBe(true);
  expect(verifyGitHubSignature(s, body, `sha256=${hmacHex(appWebhookSecret("k", 43), body)}`)).toBe(false);
  expect(verifyGitHubSignature(s, body, hmacHex(s, body))).toBe(false);
  expect(verifyGitHubSignature(s, body, null)).toBe(false);
});
