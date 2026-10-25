import { expect, test } from "bun:test";
import type { Status } from "@achq/core";
import { parseSessions } from "@achq/core/commands";
import type { ContainerShell } from "@achq/core";
import { containersOf, pickContainer } from "../pickers/container.ts";
import { pickSession } from "../pickers/session.ts";
import { sessionTable } from "../renderers/sessions.ts";
import { containerListSessions } from "../tasks/container.list-sessions.ts";
import { run } from "../tasks/run.ts";
import { testRunner } from "./runner.ts";

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
  expect(() => parseSessions("bash: achq-runner: not found")).toThrow("Unexpected output");
});

test("without a terminal, sessions print as a minimal list", () => {
  expect(sessionTable(parseSessions(OUT))).toBe(
    ["ID      THREAD  AGENT            LAST RUN", "bbb222  #34     triage (issues)  2026-10-17T09:00:00Z", "aaa111  #12     coder (issues)   2026-10-16T09:00:00Z"].join("\n"),
  );
});

test("reads what the container's `achq-runner sessions` prints", async () => {
  const { formatSessions } = await import("@achq/runner");
  const printed = formatSessions([
    { id: "s2", thread: "34", agent: "triage", workspace: "issues", lastRun: "2026-10-17T09:00:00Z" },
    { id: "s1", thread: "12", agent: "coder", workspace: "issues", lastRun: "2026-10-16T09:00:00Z" },
  ]);
  expect(parseSessions(`Connecting…\n${printed}\n`).map((s) => [s.id, s.thread, s.agent])).toEqual([["s2", "34", "triage"], ["s1", "12", "coder"]]);
  expect(parseSessions(formatSessions([]))).toEqual([]);
});

/** A container whose shell has only the binaries given, answering `sessions` with OUT, and failing as `run` does for the rest. */
const shellWith = (binaries: string[], missing = (binary: string) => `sh: 1: exec: ${binary}: not found`) => {
  const ran: string[][] = [];
  const shell: ContainerShell = {
    reachable: () => true,
    open: async () => 0,
    run: async (_location, command) => {
      ran.push(command);
      if (!binaries.includes(command[0]!)) throw new Error(`${command.join(" ")} failed in dev: ${missing(command[0]!)}`);
      return OUT;
    },
  };
  return { container: { location: {}, shell }, ran };
};

/** Lists the container's sessions as `achq container resume` does. */
const listSessions = async (container: ReturnType<typeof shellWith>["container"], thread?: string) => run(testRunner(), containerListSessions, { container, thread });

test("sessions come from achq-runner", async () => {
  const { container, ran } = shellWith(["achq-runner"]);
  expect((await listSessions(container, "34")).map((s) => s.id)).toEqual(["bbb222", "aaa111"]);
  expect(ran).toEqual([["achq-runner", "sessions", "34"]]);
});

test("a failure is the runner's, and isn't asked again", async () => {
  const { container, ran } = shellWith([]);
  await expect(listSessions(container)).rejects.toThrow("achq-runner sessions failed in dev: sh: 1: exec: achq-runner: not found");
  expect(ran).toHaveLength(1);
});
