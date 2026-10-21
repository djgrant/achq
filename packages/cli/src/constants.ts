/** The ACHQ infra file, at the infra repo's root. */
export const INFRA_FILE = "achq.infra.ts";

/** The CLI's own config, at the root of the repo it's run in. */
export const CONFIG_FILE = "achq.config.ts";

export const CLI_ENV = {
  /** The directory `achq` was run in. `bin/achq` passes it on, since pok runs from achq's own directory. */
  callerCwd: "ACHQ_CALLER_CWD",
  /** Set to keep stacks on every error. */
  debug: "ACHQ_DEBUG",
} as const;

/** The paths in achq whose latest commit is the version the router and deployer run. */
export const ACHQ_CODE_PATHS = ["packages", "package.json", "bun.lock"];

/** How long `achq repo install` waits for the deploy's result, and how often it looks. */
export const STATUS_TIMEOUT_MS = 180_000;
export const STATUS_INTERVAL_MS = 5000;

/** The terminal's variables, passed on to the container's shell, which may set only TERM=xterm. */
export const TERMINAL_ENV = ["TERM", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"];
