import { afterEach, beforeEach, expect, test } from "bun:test";
import { type FakeOp, fakeOp } from "@achq/test-utils/fakes/vendors/1password";
import { onePasswordVaultProvider } from "../src/vault/index.ts";

let op: FakeOp;
beforeEach(() => {
  op = fakeOp();
});
afterEach(() => op.stop());

const vault = (name = "achq") => onePasswordVaultProvider.create({ ACHQ_1PASSWORD_OP: op.bin }).vault(name);

test("an item reads back as its fields, and a missing one as nothing", async () => {
  expect(await vault().read("GitHub App djgrant-claude")).toBeUndefined();
  await vault().write("GitHub App djgrant-claude", { app_id: "4242", private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n" });
  expect(await vault().read("GitHub App djgrant-claude")).toEqual({ app_id: "4242", private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n" });
  // In that vault only, as a note of concealed fields.
  expect(await vault("other").read("GitHub App djgrant-claude")).toBeUndefined();
  expect(op.items()[0]!.fields.map((f) => f.type)).toEqual(["CONCEALED", "CONCEALED"]);
});

test("no value is ever on op's command line", async () => {
  await vault().write("GitHub App x", { app_id: "1", private_key: "the-secret-key" });
  await vault().read("GitHub App x");
  expect(JSON.stringify(op.calls())).not.toContain("the-secret-key");
});

test("writing an item that's there archives the old one rather than deleting it", async () => {
  await vault().write("GitHub App x", { app_id: "1", private_key: "old" });
  await vault().write("GitHub App x", { app_id: "2", private_key: "new" });
  expect(await vault().read("GitHub App x")).toEqual({ app_id: "2", private_key: "new" });
  expect(op.items().map((i) => [i.title, i.archived])).toEqual([["GitHub App x", true], ["GitHub App x", false]]);
});

test("op failing for any other reason says so", async () => {
  op.stop();
  op = fakeOp({ fails: true });
  await expect(vault().read("GitHub App x")).rejects.toThrow(`1Password couldn't read "GitHub App x" from vault achq: [ERROR] 2026/10/22 12:00:00 You are not currently signed in.`);
});
