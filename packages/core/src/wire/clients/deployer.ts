// A client for the deployer's routes, built from their declarations in `../routes/deployer.ts`.
import { type RouteFetcher, routeClient } from "@achq/utils/http";
import { deployerRoutes } from "../routes/deployer.ts";

/** The service a deployer client's HttpErrors name. */
export const DEPLOYER_SERVICE = "Deployer";

/**
 * The deployer's routes, through `fetcher`, which owns its URL and signing:
 * the router's wakes it, retrying, and signs each attempt with the admin
 * secret. A refusal throws an HttpError naming DEPLOYER_SERVICE.
 */
export const deployerClient = (fetcher: RouteFetcher) => routeClient(deployerRoutes, fetcher, { service: DEPLOYER_SERVICE });

export type DeployerClient = ReturnType<typeof deployerClient>;
