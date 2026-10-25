import { z } from "zod";
import { SessionSummary } from "./protocol.ts";

/** The runner's binary, on a repo container's PATH, as install.sh links it. */
export const RUNNER_BINARY = "achq-runner";

/** The runner's commands, by the name it dispatches on. Without one, it serves. */
export const COMMANDS = { sessions: "sessions", resume: "resume" } as const;
export type RunnerCommand = keyof typeof COMMANDS;

/** How a repo container starts: its container provider sets it, so a Dockerfile doesn't name the binary. */
export const serve = () => [RUNNER_BINARY];

/** Prints a thread's sessions, or every thread's without `thread`, for `parseSessions`. */
export const sessions = (thread?: string) => [RUNNER_BINARY, COMMANDS.sessions, ...(thread ? [thread] : [])];

/** Opens a thread's session in the agent, interactively. */
export const resume = (thread: string, session: string) => [RUNNER_BINARY, COMMANDS.resume, thread, session];

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
