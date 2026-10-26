import { expect, test } from "bun:test";
import { agentContainerEnv, CHANNEL_PROVIDERS, channelProviderNamed, CONTAINER_PROVIDERS, containerProviderNamed, findContainerProvider, privateEnv, CODE_HOST, POLICY_PROVIDERS, vaultProviderNamed } from "../src/registry.ts";

test("finds each implementation by id, and names what it knows when it can't", () => {
  expect(channelProviderNamed("github")).toBe(CHANNEL_PROVIDERS[0]!);
  expect(CODE_HOST.id).toBe("github");
  expect(containerProviderNamed("railway")).toBe(CONTAINER_PROVIDERS[0]!);
  expect(() => channelProviderNamed("slack")).toThrow(`achq doesn't know the channel provider "slack"; it knows github`);
  expect(findContainerProvider("fly")).toBeUndefined();
  expect(findContainerProvider(undefined)).toBeUndefined();
  expect(findContainerProvider("railway")?.shell).toBeDefined();
  expect(containerProviderNamed("cloudflare").shell).toBeDefined();
  expect(vaultProviderNamed("1password").id).toBe("1password");
  expect(() => vaultProviderNamed("keychain")).toThrow(`achq doesn't know the vault provider "keychain"; it knows 1password`);
});

test("privateEnv is the container secret, the key and every implementation's, once each", () => {
  const all = privateEnv();
  expect(all).toContain("ACHQ_CONTAINER_SECRET");
  expect(all).toContain("AGENT_WEBHOOK_KEY");
  for (const i of [...CHANNEL_PROVIDERS, ...POLICY_PROVIDERS, CODE_HOST, ...CONTAINER_PROVIDERS]) for (const name of i.privateEnv) expect(all).toContain(name);
  expect(new Set(all).size).toBe(all.length);
});

test("agentContainerEnv asks for the Claude token", () => {
  expect(agentContainerEnv().map((e) => e.name)).toContain("CLAUDE_CODE_OAUTH_TOKEN");
});
