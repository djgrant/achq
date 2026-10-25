import { defineTask } from "@pokit/core";
import { OLD_RUNNER_BINARY, parseSessions, RUNNER_BINARY, type RunnerBinary, sessions as sessionsArgv } from "@achq/core/commands";
import type { SessionSummary } from "@achq/core/protocol";
import { errors } from "@achq/utils/errors";
import { z } from "zod";
import type { Located } from "../pickers/container.ts";
import { given } from "./params.ts";

/** What a shell or SSH says when it can't find `binary`: sh's and bash's "not found", exec's "No such file", or the shell's exit status for it, 127. */
const notFound = (said: string, binary: string) =>
  new RegExp(`${binary}\\W{0,3}(command )?not found|${binary}\\W{0,3}no such file|"${binary}": executable file not found|exit(ed)?( with)? (status|code):? 127\\b`, "i").test(said);

/**
 * A thread's sessions, or every thread's, from the container's runner, and the
 * name of its binary that answered, which `resume` then runs.
 */
export const containerListSessions = defineTask({
  label: "List the container's sessions",
  params: z.object({ container: given<Pick<Located, "location" | "shell">>(), thread: z.string().optional() }),
  run: async (_r, { params: { container, thread } }): Promise<{ sessions: SessionSummary[]; binary: RunnerBinary }> => {
    const list = async (binary: RunnerBinary) => ({ sessions: parseSessions(await container.shell.run(container.location, sessionsArgv(thread, binary)), binary), binary });
    try {
      return await list(RUNNER_BINARY);
    } catch (error) {
      // compat: delete once deployed repos' images are all built by an install.sh that links achq-runner. One an older install.sh built has only achq-agent.
      if (notFound(errors.message(error), RUNNER_BINARY)) return list(OLD_RUNNER_BINARY);
      throw error;
    }
  },
});
