import { defineTask } from "@pokit/core";
import { sessions } from "@achq/core/commands";
import { SessionSummary } from "@achq/core/protocol";
import { z } from "zod";
import type { Reachable } from "../io/shell.ts";
import { given } from "./params.ts";

/** How much of unexpected output goes into the error: enough to see what answered. */
const UNEXPECTED_OUTPUT_CHARS = 200;

/**
 * What `sessions` prints: a JSON array of sessions, most recently run first.
 * Anything before the JSON (an SSH banner) is skipped.
 */
export const parseSessions = (out: string) => {
  const command = sessions().join(" ");
  const start = out.indexOf("[");
  if (start < 0) throw new Error(`Unexpected output from ${command}: ${out.trim().slice(0, UNEXPECTED_OUTPUT_CHARS)}`);
  const parsed = z.array(SessionSummary).safeParse(JSON.parse(out.slice(start)));
  if (!parsed.success) throw new Error(`${command} didn't return a list of sessions: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
};

/** A thread's sessions, or every thread's, from the container's runner. */
export const containerListSessions = defineTask({
  label: "List the container's sessions",
  params: z.object({ container: given<Pick<Reachable, "run">>(), thread: z.string().optional() }),
  run: async (_r, { params: { container, thread } }) => parseSessions(await container.run(sessions(thread))),
});
