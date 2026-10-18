/** The ACHQ infra file, at the infra repo's root. */
export const INFRA_FILE = "achq.infra.ts";

/** The environment variables the CLI reads. */
export const CLI_ENV = {
  /** The directory `achq` was run in. `bin/achq` passes it on, since pok runs from achq's own directory. */
  callerCwd: "ACHQ_CALLER_CWD",
  /** Set to keep stacks on every error. */
  debug: "ACHQ_DEBUG",
  /** Points the CLI's GitHub client at a fake. */
  githubApi: "ACHQ_GITHUB_API",
  railwayToken: "RAILWAY_API_TOKEN",
  railwayWorkspace: "RAILWAY_WORKSPACE_ID",
} as const;

/** What any repo's config needs from its App: pushes keep the deployment in line with the config, and the deployer writes ACHQ_STATUS. */
export const CONFIG_EVENTS = ["push"];
export const CONFIG_PERMISSIONS: Record<string, string> = { metadata: "read", actions_variables: "write" };

/** The homepage every App's manifest links to. */
export const ACHQ_HOMEPAGE = "https://github.com/djgrant/achq";
/** The paths in achq whose latest commit is the version the router and deployer run. */
export const ACHQ_CODE_PATHS = ["packages", "package.json", "bun.lock"];

/** How long `achq install` waits for the deploy's result, and how often it looks. */
export const STATUS_TIMEOUT_MS = 180_000;
export const STATUS_INTERVAL_MS = 5000;

/** The terminal's variables, passed through Railway's SSH, which sets only TERM=xterm. */
export const TERMINAL_ENV = ["TERM", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"];
