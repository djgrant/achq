import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fakeRouter } from "@achq/test-utils/container-router";
import { testPolicyProvider } from "@achq/test-utils/test-policy-provider";
import { tempDir } from "@achq/test-utils/temp-dir";
import { Credentials } from "../src/credentials.ts";
import { paths as layout } from "../src/volume.ts";

const dirs: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("credentials", () => {
  test("fetched once, reused while more than 30 minutes remain, refreshed in the background when fewer do", async () => {
    let now = Date.parse("2026-10-18T10:00:00Z");
    const router = fakeRouter("s", { now: () => now });
    cleanups.push(router.stop);
    const paths = layout(tempDir(dirs));
    const creds = new Credentials({ routerUrl: router.url, containerSecret: "s", repo: "acme/widgets", container: "dev", policyProviders: [testPolicyProvider()], paths, now: () => now });
    const tokenFile = path.join(paths.policyProvider("test-policy-provider"), "token");

    const first = await creds.get();
    expect(router.mints()).toBe(1);
    expect(first.env.TEST_TOKEN_FILE).toBe(tokenFile);
    expect(fs.readFileSync(tokenFile, "utf8")).toBe("agent-token-1");

    now += 29 * 60_000; // 31 minutes left
    await creds.get();
    expect(router.mints()).toBe(1);

    now += 2 * 60_000; // 29 minutes left: the current ones now, a refresh behind them
    const during = await creds.get();
    expect(during.credentials[0]!.value).toBe("agent-token-1");
    await Bun.sleep(100);
    expect(router.mints()).toBe(2);
    expect(fs.readFileSync(tokenFile, "utf8")).toBe("agent-token-2");
    expect((await creds.get()).credentials[0]!.value).toBe("agent-token-2");
    expect(router.mints()).toBe(2);

    now += 2 * 60 * 60_000; // all expired: waits for new ones
    expect((await creds.get()).credentials[0]!.value).toBe("agent-token-3");
    expect(await creds.channel("test", "app")).toMatchObject({ channel: "test" });
  });

  test("the router must accept the container's signature", async () => {
    const router = fakeRouter("right");
    cleanups.push(router.stop);
    const creds = new Credentials({ routerUrl: router.url, containerSecret: "wrong", repo: "a/b", container: "dev", policyProviders: [], paths: layout(tempDir(dirs)) });
    await expect(creds.get()).rejects.toThrow("401");
    expect(router.rejected).toEqual(["/credentials"]);
  });
});
