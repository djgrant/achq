import { resume } from "@achq/core/commands";
import { defineCommand } from "@pokit/core";
import { z } from "zod";
import { chooseOne, clean, terminalEnv } from "../io/terminal.ts";
import { needRepo, repoFlag } from "../io/workdir.ts";
import { pickSession } from "../pickers/session.ts";
import { sessionLabel, sessionTable } from "../renderers/sessions.ts";
import { containerListSessions } from "../tasks/container.list-sessions.ts";
import { containerReach } from "../tasks/container.reach.ts";
import { run } from "../tasks/run.ts";

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
    const container = await run(r, containerReach, { here: needRepo(context.repo), wanted: context.container });
    // The name of the runner's binary that answered is the one `resume` runs.
    const { sessions, binary } = await run(r, containerListSessions, { container, thread });
    const session = await chooseOne(r.prompter, sessions, pickSession(sessions, context.session, thread), {
      message: "Session",
      id: (s) => s.id,
      label: sessionLabel,
      hint: (s) => s.lastRun,
      withoutTerminal: () => void console.log(sessionTable(sessions)),
    });
    // Without a terminal, the list is all there is to show.
    if (!session) return;
    process.exitCode = await container.shell.open(container.location, ["env", ...terminalEnv(), ...resume(session.thread, session.id, binary)]);
  }),
});
