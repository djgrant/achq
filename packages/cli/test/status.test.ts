import { expect, test } from "bun:test";
import { infraStatusTable } from "../src/lib/status/format.ts";

test("the infra status lists installed and deployed repos, with errors underneath", () => {
  const table = infraStatusTable(
    [
      { host: "github", repo: "notationlabs/yieldstar", source: "notation-achq", state: "deployed", at: "2026-10-17T10:00:00Z", containers: [{ name: "dev", location: {} }] },
      { host: "github", repo: "djgrant/rfcs", source: "djgrant-claude", state: "failed", at: "2026-10-17T11:00:00Z", error: "no .achq/config.ts" },
    ],
    [
      { provider: "github", source: "notation-achq", repo: "NotationLabs/yieldstar" },
      { provider: "github", source: "djgrant-claude", repo: "djgrant/rfcs" },
      { provider: "github", source: "djgrant-claude", repo: "djgrant/new" },
    ],
  );
  expect(table.split("\n")).toEqual([
    "REPO                    APP             STATE                    AT                    CONTAINERS",
    "djgrant/new             djgrant-claude  installed, not deployed  -                     -",
    "djgrant/rfcs            djgrant-claude  failed                   2026-10-17T11:00:00Z  -",
    "notationlabs/yieldstar  notation-achq   deployed                 2026-10-17T10:00:00Z  dev",
    "",
    "djgrant/rfcs: no .achq/config.ts",
  ]);
});
