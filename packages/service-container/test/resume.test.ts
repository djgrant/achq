import { describe, expect, test } from "bun:test";
import { threadKey } from "@achq/core";
import { acquire, BUSY } from "@achq/flock";
import { resume } from "../src/resume.ts";
import { formatSessions, sessionsFor } from "../src/sessions.ts";
import { world } from "./world.ts";

describe("sessions and resume", () => {
  test("sessions lists a thread's sessions; resume opens the one picked, holding the lock", async () => {
    const w = await world();
    w.channel.open(8);
    await w.send(w.channel.event(8, "opened", "go"));
    const sessions = sessionsFor(w.paths, "8");
    expect(sessions.map((s) => s.agent).sort()).toEqual(["coder", "triage"]);
    const lines = JSON.parse(formatSessions(sessions));
    expect(Object.keys(lines[0]).sort()).toEqual(["agent", "id", "lastRun", "workspace"]);
    expect(sessionsFor(w.paths, "9")).toEqual([]);

    const out: string[] = [];
    const base = { paths: w.paths, number: "8", loadConfig: w.load, container: "dev", env: w.env, stdio: ["ignore", "ignore", "ignore"] as ["ignore", "ignore", "ignore"], out: (t: string) => out.push(t) };
    const triage = sessions.find((s) => s.agent === "triage")!;
    // Only an exact id; otherwise it lists the thread's sessions.
    expect(await resume({ ...base, session: "triage" })).toBe(1);
    expect(out.join("\n")).toContain(`No session triage on thread 8`);
    expect(out.join("\n")).toContain(triage.id);

    const before = w.claude.calls().length;
    expect(await resume({ ...base, session: triage.id })).toBe(0);
    const call = w.claude.calls()[before]!;
    expect(w.claude.flag(call, "--resume")).toBe(triage.id);
    expect(call.argv).not.toContain("-p");
    expect(call.argv.join(" ")).toContain("--effort max");
    expect(call.cwd).toBe(w.paths.worktree("issues", threadKey(w.channel.ref(8))));
    expect(call.env.CLAUDE_CONFIG_DIR).toBe(w.paths.agent("triage"));
    expect(call.env.TEST_TOKEN_FILE).toBeDefined();
    expect(call.env.ACHQ_CONTAINER_SECRET).toBeUndefined();

    // While a run holds the lock, resume refuses.
    const release = await acquire(w.paths.lock("issues", threadKey(w.channel.ref(8))));
    expect(await resume({ ...base, session: triage.id })).toBe(BUSY);
    await release();
  });
});
