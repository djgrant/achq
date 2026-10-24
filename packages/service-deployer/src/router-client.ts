import { routerAdmin, type RouterAdmin } from "@achq/core/client";

/** What the deployer asks of the router. Tests can fake just this. */
export type RouterClient = Pick<RouterAdmin, "mint" | "validate" | "putRepo" | "deleteRepo" | "installed" | "sources">;

/** `url` is the router's private base URL (ACHQ_ROUTER_URL). */
export const routerClient = ({ url, key }: { url: string; key: string }): RouterClient => routerAdmin({ url, key });
