import { expect, test } from "bun:test";
import type { Status } from "@achq/core";
import { containersOf, parseSessions, pickContainer, pickSession, sessionTable } from "../src/lib/container.ts";

const location = (service: string) => ({ containerProvider: "railway", project: "p1", environment: "e1", service });
const status: Status = {
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

const OUT = `Connecting…\n[{"id":"bbb222","thread":"34","agent":"triage","workspace":"issues","lastRun":"2026-10-17T09:00:00Z"},{"id":"aaa111","thread":"12","agent":"coder","workspace":"issues","lastRun":"2026-10-16T09:00:00Z"}]\n`;

test("sessions parse past a banner; one opens without asking", () => {
  const sessions = parseSessions(OUT);
  expect(sessions.map((s) => s.id)).toEqual(["bbb222", "aaa111"]);
  expect(pickSession(sessions)).toBeUndefined();
  expect(pickSession([sessions[0]])?.id).toBe("bbb222");
  expect(pickSession(sessions, "aaa")?.id).toBe("aaa111");
  expect(pickSession(sessions, "coder")?.id).toBe("aaa111");
  expect(() => pickSession([], undefined, "34")).toThrow("Thread 34 has no sessions");
  expect(() => pickSession([])).toThrow("mention an agent");
  expect(() => parseSessions("bash: achq-agent: not found")).toThrow("Unexpected output");
});

test("without a terminal, sessions print as a minimal list", () => {
  expect(sessionTable(parseSessions(OUT))).toBe(
    ["ID      THREAD  AGENT            LAST RUN", "bbb222  #34     triage (issues)  2026-10-17T09:00:00Z", "aaa111  #12     coder (issues)   2026-10-16T09:00:00Z"].join("\n"),
  );
});

test("reads what the container's `achq-agent sessions` prints", async () => {
  const { formatSessions } = await import("@achq/container");
  const printed = formatSessions([
    { id: "s2", thread: "34", agent: "triage", workspace: "issues", lastRun: "2026-10-17T09:00:00Z" },
    { id: "s1", thread: "12", agent: "coder", workspace: "issues", lastRun: "2026-10-16T09:00:00Z" },
  ]);
  expect(parseSessions(`Connecting…\n${printed}\n`).map((s) => [s.id, s.thread, s.agent])).toEqual([["s2", "34", "triage"], ["s1", "12", "coder"]]);
  expect(parseSessions(formatSessions([]))).toEqual([]);
});
