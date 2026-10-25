import { z } from "zod";
import { SessionSummary } from "./protocol.ts";

/** The runner's binary, on a repo container's PATH, as install.sh links it. */
export const RUNNER_BINARY = "achq-runner";

// compat: delete once deployed repos' Dockerfiles no longer name achq-agent, and their images are all built by an install.sh that
// links achq-runner. The runner's name before it was achq-runner: install.sh links it too, and an image an older one built has only it.
export const OLD_RUNNER_BINARY = "achq-agent";

/** A name the runner's binary answers to in some repo container. */
export type RunnerBinary = typeof RUNNER_BINARY | typeof OLD_RUNNER_BINARY;

/** The runner's commands, by the name it dispatches on. Without one, it serves. */
export const COMMANDS = { sessions: "sessions", resume: "resume" } as const;
export type RunnerCommand = keyof typeof COMMANDS;

/** How a repo container starts: its container provider sets it, so a Dockerfile doesn't name the binary. */
export const serve = () => [
  "sh",
  "-c",
  // compat: delete once deployed repos' images are all built by an install.sh that links achq-runner. One an older install.sh
  // built, or that kept its install.sh layer from the build cache, has only achq-agent, while its provider starts it with this.
  `command -v ${RUNNER_BINARY} > /dev/null && exec ${RUNNER_BINARY} || exec ${OLD_RUNNER_BINARY}`,
];

/** Prints a thread's sessions, or every thread's without `thread`, for `parseSessions`. `binary` is the name the runner answers to. */
export const sessions = (thread?: string, binary: RunnerBinary = RUNNER_BINARY) => [binary, COMMANDS.sessions, ...(thread ? [thread] : [])];

/** Opens a thread's session in the agent, interactively, by the name the runner answered `sessions` to. */
export const resume = (thread: string, session: string, binary: RunnerBinary = RUNNER_BINARY) => [binary, COMMANDS.resume, thread, session];

/** How much of unexpected output goes into the error: enough to see what answered. */
const UNEXPECTED_OUTPUT_CHARS = 200;

/**
 * What `sessions` prints: a JSON array of sessions, most recently run first.
 * Anything before the JSON (an SSH banner) is skipped.
 */
export const parseSessions = (out: string, binary: RunnerBinary = RUNNER_BINARY) => {
  const command = sessions(undefined, binary).join(" ");
  const start = out.indexOf("[");
  if (start < 0) throw new Error(`Unexpected output from ${command}: ${out.trim().slice(0, UNEXPECTED_OUTPUT_CHARS)}`);
  const parsed = z.array(SessionSummary).safeParse(JSON.parse(out.slice(start)));
  if (!parsed.success) throw new Error(`${command} didn't return a list of sessions: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
};
