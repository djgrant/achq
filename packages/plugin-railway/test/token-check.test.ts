import { afterEach, expect, test } from "bun:test";
import { startFakeRailway } from "@achq/test-utils/fakes/vendors/railway";
import { railwayContainerProvider } from "../src/container/index.ts";

const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach((stop) => stop()));

const check = (env: Record<string, string>) => railwayContainerProvider.checks!(env)[0]!;

test("the container provider checks that Railway takes the token", async () => {
  const fake = startFakeRailway();
  stops.push(() => fake.stop());
  await expect(check({ RAILWAY_API_TOKEN: "t", RAILWAY_API_URL: fake.url }).check()).resolves.toBeUndefined();
});

test("a token Railway turns down fails the check, naming the variable, with what to do", async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ errors: [{ message: "Not Authorized" }] }) });
  stops.push(() => server.stop(true));
  const tokenCheck = check({ RAILWAY_API_TOKEN: "expired", RAILWAY_API_URL: server.url.href });
  await expect(tokenCheck.check()).rejects.toThrow("Railway turned down RAILWAY_API_TOKEN (Railway: Not Authorized)");
  expect(tokenCheck.remediation?.join("\n")).toContain("https://railway.com/account/tokens");
});

test("a missing token fails the check", async () => {
  await expect(check({}).check()).rejects.toThrow("Missing RAILWAY_API_TOKEN");
});
