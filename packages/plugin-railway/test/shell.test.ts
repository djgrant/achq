import { expect, test } from "bun:test";
import { railwayShell } from "../src/container-hosts/shell.ts";

const location = { platform: "railway", project: "p1", environment: "e1", service: "notationlabs-yieldstar-dev" };

test("ssh targets the container's project, environment and service", () => {
  expect(railwayShell.sshArgs(location, ["ls", "/data"])).toEqual([
    "ssh", "--project", "p1", "--environment", "e1", "--service", "notationlabs-yieldstar-dev", "--", "ls", "/data",
  ]);
});

test("a location without a project, environment and service can't be reached", () => {
  expect(railwayShell.reachable(location)).toBe(true);
  expect(railwayShell.reachable({ platform: "railway", project: "p1" })).toBe(false);
});
