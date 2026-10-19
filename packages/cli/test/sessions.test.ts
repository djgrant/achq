import { expect, test } from "bun:test";
import { parseSessions, pickSession, sessionTable } from "../src/lib/remote/sessions.ts";

const OUT = `Connecting…\n[{"id":"bbb222","agent":"triage","workspace":"issues","lastRun":"2026-10-17T09:00:00Z"},{"id":"aaa111","agent":"coder","workspace":"issues","lastRun":"2026-10-16T09:00:00Z"}]\n`;

test("sessions parse past a banner; one opens without asking", () => {
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
    ["ID      AGENT            LAST RUN", "bbb222  triage (issues)  2026-10-17T09:00:00Z", "aaa111  coder (issues)   2026-10-16T09:00:00Z"].join("\n"),
  );
});

test("reads what the container's `achq-agent sessions` prints", async () => {
  const { formatSessions } = await import("@achq/container");
  const printed = formatSessions([
    { id: "s2", agent: "triage", workspace: "issues", lastRun: "2026-10-17T09:00:00Z" },
    { id: "s1", agent: "coder", workspace: "issues", lastRun: "2026-10-16T09:00:00Z" },
  ]);
  expect(parseSessions(`Connecting…\n${printed}\n`).map((s) => [s.id, s.agent])).toEqual([["s2", "triage"], ["s1", "coder"]]);
  expect(parseSessions(formatSessions([]))).toEqual([]);
});
