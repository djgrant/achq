import { expect, test } from "bun:test";
import { containerServiceName, serviceName } from "../src/lib/names.ts";

test("service names are lowercase, dash-separated and fit a hostname", () => {
  expect(containerServiceName("NotationLabs/yieldstar.dev", "dev")).toBe("notationlabs-yieldstar-dev-dev");
  const long = serviceName("a".repeat(40), "b".repeat(40));
  expect(long.length).toBeLessThanOrEqual(63);
  expect(long).not.toBe(serviceName("a".repeat(40), "b".repeat(39), "c"));
});
