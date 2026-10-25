import { CONTAINER_PORT } from "@achq/core";
import { RUNNER_BINARY } from "@achq/core/commands";
import type { Vars } from "@achq/utils/env";
import { runnerFromEnv } from "../from-env.ts";
import type { Paths } from "../features/layout.ts";
import { routes } from "../routes.ts";

/** "::" so private networks over IPv6 reach it. */
const ALL_INTERFACES = "::";

/** `serve()`, what the container provider starts it with: tells threads about runs a restart cut short, then serves the router's deliveries. */
export const serve = async (vars: Vars, paths: Paths, { repo, container }: { repo: string; container: string }) => {
  process.env.HOME = paths.home;
  const runner = runnerFromEnv(vars);
  await runner.reportInterrupted().catch((e) => console.error("reporting interrupted runs failed", e));
  Bun.serve({ port: CONTAINER_PORT, hostname: ALL_INTERFACES, fetch: routes(runner).fetch });
  console.log(`${RUNNER_BINARY} for ${repo} (${container}), listening on :${CONTAINER_PORT}`);
};
