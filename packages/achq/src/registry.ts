// The providers achq is built with. The CLI, router, deployer and container
// only use core's interfaces, and find the implementation here by id.
import { claudeAgent } from "@achq/claude/runtime";
import type { AgentProvider, Platform, Provider } from "@achq/core";
import { githubProvider } from "@achq/github/provider";
import { railwayPlatform } from "@achq/railway/runtime";
import * as github from "./github.ts";
import * as achq from "./index.ts";
import * as railway from "./railway.ts";

export const PLATFORMS: Platform[] = [railwayPlatform];
export const PROVIDERS: Provider[] = [githubProvider];
export const AGENTS: AgentProvider[] = [claudeAgent];

/** The bare imports a repo's `.achq/` may use. */
export const CONFIG_MODULES = ["achq", "achq/github"];
/** What the infra file's imports resolve to. */
export const INFRA_MODULES: Record<string, object> = { achq, "achq/github": github, "achq/railway": railway };

const lookup =
  <T extends { id: string }>(kind: string, all: T[]) =>
  (id: string): T => {
    const found = all.find((x) => x.id === id);
    if (!found) throw new Error(`achq doesn't know the ${kind} "${id}"; it knows ${all.map((x) => x.id).join(", ")}`);
    return found;
  };

export const platformNamed = lookup("platform", PLATFORMS);
export const findPlatform = (id: string | undefined) => PLATFORMS.find((p) => p.id === id);
export const providerNamed = lookup("provider", PROVIDERS);

/** The variables every container needs, for every agent runtime. */
export const agentEnv = () => AGENTS.flatMap((a) => a.containerEnv);
