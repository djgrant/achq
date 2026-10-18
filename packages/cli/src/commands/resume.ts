import { defineCommand } from "@pokit/core";
import { clean } from "../lib/errors.ts";
import { z } from "zod";
import { railwayRun, railwaySsh } from "../lib/remote/railway-ssh.ts";
import { reachContainer } from "../lib/remote/reach.ts";
import { parseSessions, pickSession, sessionLabel, sessionTable } from "../lib/remote/sessions.ts";
import { interactive, terminalEnv } from "../lib/terminal.ts";
import { needRepo } from "../lib/workdir.ts";

export const command = defineCommand({
  label: "Open a thread's agent session",
  examples: ["achq resume 34", "achq resume 34 <session>"],
  context: {
    thread: { from: "arg", schema: z.coerce.number().int().positive(), description: "Issue number" },
    session: { from: "arg", schema: z.string().optional(), description: "Session ID (or agent name)" },
    container: { from: "flag", schema: z.string().optional(), description: "Which container, when the repo has several" },
  },
  run: clean(async (r, { context }) => {
    const thread = String(context.thread);
    const container = await reachContainer(r.prompter, needRepo(), context.container);
    const sessions = parseSessions(await railwayRun(container, ["achq-agent", "sessions", thread]));
    let session = pickSession(sessions, context.session);
    if (!session) {
      if (!interactive()) {
        console.log(sessionTable(sessions));
        return;
      }
      const id = await r.prompter.select({
        message: "Session",
        options: sessions.map((s) => ({ value: s.id, label: sessionLabel(s), hint: s.lastRun })),
      });
      session = sessions.find((s) => s.id === id)!;
    }
    process.exitCode = await railwaySsh(container, ["env", ...terminalEnv(), "achq-agent", "resume", thread, session.id]);
  }),
});
