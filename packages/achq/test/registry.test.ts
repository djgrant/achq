import { expect, test } from "bun:test";
import { App } from "@achq/github/infra";
import { Router } from "@achq/railway/infra";
import { ACCESS, agentEnv, CHANNELS, channelNamed, CONTAINER_HOSTS, containerHostNamed, findContainerHost, INFRA_MODULES, privateEnv, REPO_HOSTS, repoHostNamed } from "../src/registry.ts";

test("finds each implementation by id, and names what it knows when it can't", () => {
  expect(channelNamed("github")).toBe(CHANNELS[0]!);
  expect(repoHostNamed("github")).toBe(REPO_HOSTS[0]!);
  expect(containerHostNamed("railway")).toBe(CONTAINER_HOSTS[0]!);
  expect(() => channelNamed("slack")).toThrow(`achq doesn't know the channel "slack"; it knows github`);
  expect(findContainerHost("fly")).toBeUndefined();
  expect(findContainerHost(undefined)).toBeUndefined();
  expect(findContainerHost("railway")?.shell).toBeDefined();
});

test("privateEnv is every implementation's, once each", () => {
  const all = privateEnv();
  for (const i of [...CHANNELS, ...ACCESS, ...REPO_HOSTS, ...CONTAINER_HOSTS]) for (const name of i.privateEnv) expect(all).toContain(name);
  expect(new Set(all).size).toBe(all.length);
});

test("agentEnv asks for the Claude token", () => {
  expect(agentEnv().map((e) => e.name)).toContain("CLAUDE_CODE_OAUTH_TOKEN");
});

test("the infra's imports resolve to the infra sides", () => {
  expect((INFRA_MODULES["achq/github"] as { App: unknown }).App).toBe(App);
  expect((INFRA_MODULES["achq/railway"] as { Router: unknown }).Router).toBe(Router);
});
