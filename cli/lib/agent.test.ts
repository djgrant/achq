import { expect, test } from "bun:test";
import { findService, serviceName } from "./agent.ts";

test("serviceName includes the owner", () => {
  expect(serviceName("djgrant/gh-agent-test")).toBe("djgrant-gh-agent-test");
  expect(serviceName("NotationLabs/yieldstar.dev")).toBe("notationlabs-yieldstar-dev");
});

test("findService takes owner/repo, or a repo name only one service ends in", () => {
  const services = [{ name: "djgrant-rfcs" }, { name: "notationlabs-rfcs" }, { name: "djgrant-gh-agent-test" }];
  expect(findService(services, "notationlabs/rfcs").name).toBe("notationlabs-rfcs");
  expect(findService(services, "gh-agent-test").name).toBe("djgrant-gh-agent-test");
  expect(() => findService(services, "rfcs")).toThrow("Use owner/repo");
  expect(() => findService(services, "nope")).toThrow("No agent deployed");
});
