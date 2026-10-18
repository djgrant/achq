import type { Expander } from "@achq/core";
import type { RailwayInfraDeps } from "./deps.ts";
import { deployerExpander } from "./deployer.ts";
import { routerExpander } from "./router.ts";

/** How `achq up` builds the infra's Railway resources. */
export const railwayExpanders = (deps: RailwayInfraDeps): Expander[] => [routerExpander(deps), deployerExpander(deps)];
