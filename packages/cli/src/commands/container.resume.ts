import { defineCommand } from "@pokit/core";
import { chooseOne } from "../lib/choose.ts";
import { clean } from "../lib/errors.ts";
import { z } from "zod";
import { reachContainer } from "../lib/remote/reach.ts";
import { parseSessions, pickSession, sessionLabel, sessionTable } from "../lib/remote/sessions.ts";
import { terminalEnv } from "../lib/terminal.ts";
import { needRepo, repoFlag } from "../lib/workdir.ts";

export const command = defineCommand({
  label: "Open a thread's agent session",
  examples: ["achq container resume 34", "achq container resume 34 <session>", "achq container resume 34 --repo djgrant/foo"],
  context: {
    thread: { from: "arg", schema: z.coerce.number().int().positive(), description: "Issue number" },
    session: { from: "arg", schema: z.string().optional(), description: "Session ID or agent name" },
    repo: repoFlag,
    container: { from: "flag", schema: z.string().optional(), description: "Container name" },
  },
  run: clean(async (r, { context }) => {
    const thread = String(context.thread);
    const container = await reachContainer(r.prompter, needRepo(context.repo), context.container);
    const sessions = parseSessions(await container.shell.run(container.location, ["achq-agent", "sessions", thread]));
    const session = await chooseOne(r.prompter, sessions, pickSession(sessions, context.session), {
      message: "Session",
      id: (s) => s.id,
      label: sessionLabel,
      hint: (s) => s.lastRun,
      withoutTerminal: () => void console.log(sessionTable(sessions)),
    });
    // Without a terminal, the list is all there is to show.
    if (!session) return;
    process.exitCode = await container.shell.open(container.location, ["env", ...terminalEnv(), "achq-agent", "resume", thread, session.id]);
  }),
});
