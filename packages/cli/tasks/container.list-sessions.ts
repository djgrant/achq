import { defineTask } from "@pokit/core";
import { parseSessions, sessions } from "@achq/core/commands";
import { z } from "zod";
import type { Located } from "../pickers/container.ts";
import { given } from "./params.ts";

/** A thread's sessions, or every thread's, from the container's runner. */
export const containerListSessions = defineTask({
  label: "List the container's sessions",
  params: z.object({ container: given<Pick<Located, "location" | "shell">>(), thread: z.string().optional() }),
  run: async (_r, { params: { container, thread } }) => parseSessions(await container.shell.run(container.location, sessions(thread))),
});
