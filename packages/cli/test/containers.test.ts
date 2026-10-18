import { expect, test } from "bun:test";
import type { Status } from "@achq/core";
import { containersOf, pickContainer } from "../src/lib/remote/containers.ts";
import { sshArgs } from "../src/lib/remote/railway-ssh.ts";

const location = (service: string) => ({ platform: "railway", project: "p1", environment: "e1", service });
const status: Status = {
  repo: "notationlabs/yieldstar",
  source: "notation-achq",
  state: "deployed",
  at: "2026-10-17T10:02:00Z",
  router: "https://achq-router.up.railway.app",
  containers: [
    { name: "dev", location: location("notationlabs-yieldstar-dev") },
    { name: "docs", location: location("notationlabs-yieldstar-docs") },
    { name: "elsewhere", location: { platform: "fly" } },
  ],
};

test("containers come from ACHQ_STATUS; only Railway ones can be reached", () => {
  expect(containersOf(status).map((c) => c.name)).toEqual(["dev", "docs"]);
});

test("one container is picked without asking; several need --container or a pick", () => {
  const all = containersOf(status);
  expect(pickContainer([all[0]])?.name).toBe("dev");
  expect(pickContainer(all)).toBeUndefined();
  expect(pickContainer(all, "docs")?.service).toBe("notationlabs-yieldstar-docs");
  expect(() => pickContainer(all, "nope")).toThrow("there's dev, docs");
  expect(() => pickContainer([])).toThrow("no containers");
});

test("ssh targets the container's project, environment and service", () => {
  expect(sshArgs(containersOf(status)[0], ["ls", "/data"])).toEqual([
    "ssh", "--project", "p1", "--environment", "e1", "--service", "notationlabs-yieldstar-dev", "--", "ls", "/data",
  ]);
});
