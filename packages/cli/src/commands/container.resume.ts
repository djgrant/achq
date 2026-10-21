import { defineCommand } from "@pokit/core";
import { z } from "zod";
import { parseSessions, pickSession, reachContainer, sessionLabel, sessionTable } from "../lib/container.ts";
import { chooseOne, clean, terminalEnv } from "../lib/terminal.ts";
import { needRepo, repoFlag } from "../lib/workdir.ts";

export const command = defineCommand({
  label: "Open an agent session",
  examples: ["achq container resume", "achq container resume 34", "achq container resume 34 <session>", "achq container resume --repo djgrant/foo"],
  context: {
    thread: { from: "arg", schema: z.coerce.number().int().positive().optional(), description: "Issue number (default: pick from all sessions)" },
    session: { from: "arg", schema: z.string().optional(), description: "Session ID or agent name" },
    repo: repoFlag,
    container: { from: "flag", schema: z.string().optional(), description: "Container name" },
  },
  run: clean(async (r, { context }) => {
    const thread = context.thread === undefined ? undefined : String(context.thread);
    const container = await reachContainer(r.prompter, needRepo(context.repo), context.container);
    const sessions = parseSessions(await container.shell.run(container.location, ["achq-agent", "sessions", ...(thread ? [thread] : [])]));
    const session = await chooseOne(r.prompter, sessions, pickSession(sessions, context.session, thread), {
      message: "Session",
      id: (s) => s.id,
      label: sessionLabel,
      hint: (s) => s.lastRun,
      withoutTerminal: () => void console.log(sessionTable(sessions)),
    });
    // Without a terminal, the list is all there is to show.
    if (!session) return;
    process.exitCode = await container.shell.open(container.location, ["env", ...terminalEnv(), "achq-agent", "resume", session.thread, session.id]);
  }),
});
