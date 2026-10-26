import type { Providers } from "@achq/core";
import { railwayContainerProvider } from "./container/index.ts";

/** What the router and deployer load from this package, when they run on Railway. */
export const providers: Providers = { containers: [railwayContainerProvider] };
