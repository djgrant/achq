import { expect, test } from "bun:test";
import { infraStatusTable } from "../src/lib/status/format.ts";

test("the infra status lists installed and deployed repos, with errors underneath", () => {
  const table = infraStatusTable(
    [
      { host: "github", repo: "notationlabs/yieldstar", state: "deployed", at: "2026-10-17T10:00:00Z", containers: [{ name: "dev", location: {} }] },
      { host: "github", repo: "djgrant/rfcs", state: "failed", at: "2026-10-17T11:00:00Z", error: "no .achq/config.ts" },
    ],
    [
      { host: "github", repo: "NotationLabs/yieldstar" },
      { host: "github", repo: "djgrant/rfcs" },
      { host: "github", repo: "djgrant/new" },
    ],
  );
  expect(table.split("\n")).toEqual([
    "REPO                    STATE                    AT                    CONTAINERS",
    "djgrant/new             installed, not deployed  -                     -",
    "djgrant/rfcs            failed                   2026-10-17T11:00:00Z  -",
    "notationlabs/yieldstar  deployed                 2026-10-17T10:00:00Z  dev",
    "",
    "djgrant/rfcs: no .achq/config.ts",
  ]);
});
