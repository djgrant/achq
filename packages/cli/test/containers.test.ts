import { expect, test } from "bun:test";
import type { Status } from "@achq/core";
import { containersOf, pickContainer } from "../src/lib/remote/containers.ts";

const location = (service: string) => ({ containerProvider: "railway", project: "p1", environment: "e1", service });
const status: Status = {
  host: "github",
  repo: "notationlabs/yieldstar",
  state: "deployed",
  at: "2026-10-17T10:02:00Z",
  router: "https://achq-router.up.railway.app",
  containers: [
    { name: "dev", location: location("notationlabs-yieldstar-dev") },
    { name: "docs", location: location("notationlabs-yieldstar-docs") },
    { name: "elsewhere", location: { containerProvider: "fly" } },
  ],
};

test("containers come from ACHQ_STATUS; only ones on a container provider achq knows are listed", () => {
  expect(containersOf(status).map((c) => c.name)).toEqual(["dev", "docs"]);
});

test("one container is picked without asking; several need --container or a pick", () => {
  const all = containersOf(status);
  expect(pickContainer([all[0]])?.name).toBe("dev");
  expect(pickContainer(all)).toBeUndefined();
  expect(pickContainer(all, "docs")?.location.service).toBe("notationlabs-yieldstar-docs");
  expect(() => pickContainer(all, "nope")).toThrow("there's dev, docs");
  expect(() => pickContainer([])).toThrow("no containers");
});
