import { afterEach, expect, test } from "bun:test";
import { type FakeCloudflare, fakeWrangler, startFakeCloudflare } from "@achq/test-utils/cloudflare";
import { cloudflareContainerProvider } from "../src/container/index.ts";
import { connect, forgetSignIn } from "../src/lib/cloudflare.ts";

const fakes: FakeCloudflare[] = [];
afterEach(() => {
  for (const fake of fakes.splice(0)) fake.stop();
  forgetSignIn();
});

const start = (seed: Parameters<typeof startFakeCloudflare>[0] = {}) => {
  const fake = startFakeCloudflare(seed);
  fakes.push(fake);
  return fake;
};

const check = (env: Record<string, string>) => cloudflareContainerProvider.checks!(env)[0]!;

test("signed in to Wrangler, the check reads the account with Wrangler's OAuth token, the only account it reaches", async () => {
  const fake = start();
  const env = { CLOUDFLARE_API_URL: fake.url, ACHQ_CLOUDFLARE_WRANGLER: fakeWrangler(fake) };
  await expect(check(env).check()).resolves.toBeUndefined();
  expect(fake.requests).toEqual([{ call: "GET ", token: "cf-oauth" }]);
  expect((await connect(env)).accountId).toBe(fake.accountId);
});

test("not signed in, the check says to sign Wrangler in", async () => {
  const fake = start();
  const tokenCheck = check({ CLOUDFLARE_API_URL: fake.url, ACHQ_CLOUDFLARE_WRANGLER: fakeWrangler(fake, { signedIn: false }) });
  await expect(tokenCheck.check()).rejects.toThrow("Wrangler isn't signed in to Cloudflare. Run `npx wrangler login`, or set CLOUDFLARE_API_TOKEN");
  expect(tokenCheck.remediation).toContain("Sign Wrangler in: npx wrangler login");
});

test("CLOUDFLARE_API_TOKEN, as in CI, is used instead of Wrangler's sign-in", async () => {
  const fake = start();
  const env = { CLOUDFLARE_API_TOKEN: "cf-token", CLOUDFLARE_API_URL: fake.url, ACHQ_CLOUDFLARE_WRANGLER: "/nonexistent/wrangler" };
  await expect(check(env).check()).resolves.toBeUndefined();
  expect(fake.requests.map((r) => r.token)).toEqual(["cf-token"]);
});

test("a token Cloudflare turns down fails the check", async () => {
  const fake = start();
  await expect(check({ CLOUDFLARE_API_TOKEN: "expired", CLOUDFLARE_ACCOUNT_ID: fake.accountId, CLOUDFLARE_API_URL: fake.url }).check()).rejects.toThrow(
    "Cloudflare won't show account acct to your sign-in (Cloudflare GET /accounts/acct: 401 Invalid API Token (1000))",
  );
});

test("a sign-in that reaches several accounts needs CLOUDFLARE_ACCOUNT_ID, and one it can't read fails", async () => {
  const fake = start({ otherAccounts: ["other"] });
  const env = { CLOUDFLARE_API_URL: fake.url, ACHQ_CLOUDFLARE_WRANGLER: fakeWrangler(fake) };
  await expect(check(env).check()).rejects.toThrow("You can reach 2 Cloudflare accounts: acct (acct's account), other (other's account). Set CLOUDFLARE_ACCOUNT_ID to one.");
  await expect(check({ ...env, CLOUDFLARE_ACCOUNT_ID: "acct" }).check()).resolves.toBeUndefined();
  await expect(check({ ...env, CLOUDFLARE_ACCOUNT_ID: "elsewhere" }).check()).rejects.toThrow("Cloudflare won't show account elsewhere to your sign-in");
});
