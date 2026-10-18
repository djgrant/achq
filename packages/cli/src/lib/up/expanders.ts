import type { Expander } from "@achq/core";
import { type AppDeps, githubExpanders } from "@achq/github/runtime";
import { type RailwayInfraDeps, railwayExpanders } from "@achq/railway/runtime";

export type ExpanderDeps = RailwayInfraDeps & AppDeps;

/** Every platform an infra can use. */
export const infraExpanders = (deps: ExpanderDeps): Expander[] => [...railwayExpanders(deps), ...githubExpanders(deps)];
