import { expect, test } from "bun:test";
import { Channel } from "@achq/github/infra";
import { Router } from "@achq/railway/infra";
import { agentEnv, CHANNEL_PROVIDERS, INSTALLATION_PROVIDERS, channelProviderNamed, CONTAINER_PROVIDERS, containerProviderNamed, findContainerProvider, INFRA_MODULES, privateEnv, CODE_HOST_PROVIDERS, codeHostProviderNamed, POLICY_PROVIDERS } from "../src/registry.ts";

test("finds each implementation by id, and names what it knows when it can't", () => {
  expect(channelProviderNamed("github")).toBe(CHANNEL_PROVIDERS[0]!);
  expect(codeHostProviderNamed("github")).toBe(CODE_HOST_PROVIDERS[0]!);
  expect(containerProviderNamed("railway")).toBe(CONTAINER_PROVIDERS[0]!);
  expect(() => channelProviderNamed("slack")).toThrow(`achq doesn't know the channel provider "slack"; it knows github`);
  expect(findContainerProvider("fly")).toBeUndefined();
  expect(findContainerProvider(undefined)).toBeUndefined();
  expect(findContainerProvider("railway")?.shell).toBeDefined();
});

test("privateEnv is every implementation's, once each", () => {
  const all = privateEnv();
  for (const i of [...CHANNEL_PROVIDERS, ...INSTALLATION_PROVIDERS, ...POLICY_PROVIDERS, ...CODE_HOST_PROVIDERS, ...CONTAINER_PROVIDERS]) for (const name of i.privateEnv) expect(all).toContain(name);
  expect(new Set(all).size).toBe(all.length);
});

test("agentEnv asks for the Claude token", () => {
  expect(agentEnv().map((e) => e.name)).toContain("CLAUDE_CODE_OAUTH_TOKEN");
});

test("the infra's imports resolve to the infra sides", () => {
  expect((INFRA_MODULES["achq/github"] as { Channel: unknown }).Channel).toBe(Channel);
  expect((INFRA_MODULES["achq/railway"] as { Router: unknown }).Router).toBe(Router);
});
