import { expect, test } from "bun:test";
import type { Status } from "../../src/core/protocol.ts";
import { containersOf, parseSessions, pickContainer, pickSession, sessionTable, sshArgs } from "./remote.ts";
import { infraStatusTable } from "./status.ts";

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

const OUT = `Connecting…\n[{"id":"aaa111","agent":"coder","workspace":"issues","lastRun":"2026-10-16T09:00:00Z"},{"id":"bbb222","agent":"triage","lastRun":"2026-10-17T09:00:00Z"}]\n`;

test("sessions parse past a banner, newest first; one opens without asking", () => {
  const sessions = parseSessions(OUT);
  expect(sessions.map((s) => s.id)).toEqual(["bbb222", "aaa111"]);
  expect(pickSession(sessions)).toBeUndefined();
  expect(pickSession([sessions[0]])?.id).toBe("bbb222");
  expect(pickSession(sessions, "aaa")?.id).toBe("aaa111");
  expect(pickSession(sessions, "coder")?.id).toBe("aaa111");
  expect(() => pickSession([])).toThrow("no sessions");
  expect(() => parseSessions("bash: achq-agent: not found")).toThrow("Unexpected output");
});

test("without a terminal, sessions print as a minimal list", () => {
  expect(sessionTable(parseSessions(OUT))).toBe(
    ["ID      AGENT           LAST RUN", "bbb222  triage          2026-10-17T09:00:00Z", "aaa111  coder (issues)  2026-10-16T09:00:00Z"].join("\n"),
  );
});

test("the infra status lists installed and deployed repos, with errors underneath", () => {
  const table = infraStatusTable(
    [
      { repo: "notationlabs/yieldstar", source: "notation-achq", state: "deployed", at: "2026-10-17T10:00:00Z", containers: [{ name: "dev", location: {} }] },
      { repo: "djgrant/rfcs", source: "djgrant-claude", state: "failed", at: "2026-10-17T11:00:00Z", error: "no .achq/config.ts" },
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

test("reads what the container's `achq-agent sessions` prints", async () => {
  const { formatSessions } = await import("../../src/container/cli.ts");
  const printed = formatSessions([
    { id: "s1", agent: "coder", workspace: "issues", lastRun: "2026-10-16T09:00:00Z" },
    { id: "s2", agent: "triage", workspace: "issues", lastRun: "2026-10-17T09:00:00Z" },
  ]);
  expect(parseSessions(`Connecting…\n${printed}\n`).map((s) => [s.id, s.agent])).toEqual([["s2", "triage"], ["s1", "coder"]]);
  expect(parseSessions(formatSessions([]))).toEqual([]);
});
