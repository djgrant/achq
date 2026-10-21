import { expect, test } from "bun:test";
import { failedSection, formatReplay, infraStatusTable } from "../src/lib/format.ts";

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

test("the infra status lists failed deliveries under the table, each target with why, and says how to replay them", () => {
  expect(failedSection([])).toEqual([]);
  expect(
    failedSection([
      {
        delivery: "d-1",
        type: "issue_comment.created",
        repo: "notationlabs/yieldstar",
        thread: { channel: "github", id: "notationlabs/yieldstar#43" },
        targets: [{ target: "notationlabs/yieldstar/dev", error: "gave up after 5 attempts (503 waking)" }],
      },
    ]),
  ).toEqual([
    "",
    "1 delivery failed. Run `achq infra replay` to send it again:",
    "  d-1  issue_comment.created  github:notationlabs/yieldstar#43 → notationlabs/yieldstar/dev: gave up after 5 attempts (503 waking)",
  ]);
});

test("replay says what it sent again and what it dropped", () => {
  expect(formatReplay({ replayed: [], dropped: [] })).toEqual(["No delivery has failed"]);
  expect(formatReplay({ replayed: ["d-1", "d-2"], dropped: ["d-3"] })).toEqual([
    "Replaying 2 deliveries: d-1, d-2. `achq infra status` shows any that fail again.",
    "Dropped 1 delivery whose repo or container is gone: d-3",
  ]);
});
