import { expect, test } from "bun:test";
import { containerWorkerName, privateUrl, workerName } from "../src/lib/names.ts";

test("Worker names are their project's, lowercase, dash-separated, and fit a hostname", () => {
  expect(containerWorkerName("achq", "NotationLabs/yieldstar.dev", "dev")).toBe("achq-notationlabs-yieldstar-dev-dev");
  const long = workerName("a".repeat(40), "b".repeat(40));
  expect(long.length).toBeLessThanOrEqual(63);
  expect(long).not.toBe(workerName("a".repeat(40), "b".repeat(39), "c"));
});

test("a private URL names the port in its host: a container's requests are intercepted on port 80", () => {
  expect(privateUrl("achq-router", 8081)).toBe("http://8081.achq-router.achq.internal");
});
