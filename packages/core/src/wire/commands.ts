// Zod-free: plugins import serve. The CLI parses what `sessions` prints.

/** The runner's binary, on a repo container's PATH, as install.sh links it. */
export const RUNNER_BINARY = "achq-runner";

/** The runner's commands, by the name it dispatches on. Without one, it serves. */
export const COMMANDS = { sessions: "sessions", resume: "resume" } as const;
export type RunnerCommand = keyof typeof COMMANDS;

/** How a repo container starts: its container provider sets it, so a Dockerfile doesn't name the binary. */
export const serve = () => [RUNNER_BINARY];

/** Prints a thread's sessions, or every thread's without `thread`, for the CLI to parse. */
export const sessions = (thread?: string) => [RUNNER_BINARY, COMMANDS.sessions, ...(thread ? [thread] : [])];

/** Opens a thread's session in the agent, interactively. */
export const resume = (thread: string, session: string) => [RUNNER_BINARY, COMMANDS.resume, thread, session];
