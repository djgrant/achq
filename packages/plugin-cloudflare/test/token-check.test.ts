import { afterEach, expect, test } from "bun:test";
import { startFakeCloudflare } from "@achq/test-utils/cloudflare";
import { cloudflareContainerProvider } from "../src/container/index.ts";

const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach((stop) => stop()));

const check = (env: Record<string, string>) => cloudflareContainerProvider.checks!(env)[0]!;

test("the container provider checks that Cloudflare takes the token", async () => {
  const fake = startFakeCloudflare();
  stops.push(() => fake.stop());
  await expect(check({ CLOUDFLARE_API_TOKEN: "cf-token", CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_URL: fake.url }).check()).resolves.toBeUndefined();
});

test("a token Cloudflare turns down fails the check, naming the variable, with what to do", async () => {
  const fake = startFakeCloudflare();
  stops.push(() => fake.stop());
  const tokenCheck = check({ CLOUDFLARE_API_TOKEN: "expired", CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_URL: fake.url });
  await expect(tokenCheck.check()).rejects.toThrow("Cloudflare turned down CLOUDFLARE_API_TOKEN (Cloudflare GET /user/tokens/verify: 401 Invalid API Token (401))");
  expect(tokenCheck.remediation?.join("\n")).toContain("Workers Builds Configuration");
});

test("a missing token or account fails the check", async () => {
  await expect(check({}).check()).rejects.toThrow("Missing CLOUDFLARE_API_TOKEN");
  await expect(check({ CLOUDFLARE_API_TOKEN: "t" }).check()).rejects.toThrow("Missing CLOUDFLARE_ACCOUNT_ID");
});
