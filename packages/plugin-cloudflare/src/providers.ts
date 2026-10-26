import type { Providers } from "@achq/core";
import { cloudflareContainerProvider } from "./container/index.ts";

/** What the router and deployer load from this package, when they run on Cloudflare. */
export const providers: Providers = { containers: [cloudflareContainerProvider] };
