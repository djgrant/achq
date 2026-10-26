import { defineTask } from "@pokit/core";
import { parseSessions, sessions } from "@achq/core/commands";
import { z } from "zod";
import type { Reachable } from "../io/shell.ts";
import { given } from "./params.ts";

/** A thread's sessions, or every thread's, from the container's runner. */
export const containerListSessions = defineTask({
  label: "List the container's sessions",
  params: z.object({ container: given<Pick<Reachable, "run">>(), thread: z.string().optional() }),
  run: async (_r, { params: { container, thread } }) => parseSessions(await container.run(sessions(thread))),
});
