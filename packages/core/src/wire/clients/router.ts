// Clients for the router's routes, each built from their declarations in `../routes/`.
import { type RouteFetcher, routeClient } from "@achq/utils/http";
import { routerAdminRoutes } from "../routes/router-admin.ts";
import { routerContainerRoutes } from "../routes/router-container.ts";
import { routerPublicRoutes } from "../routes/router-public.ts";
import { adminSecret } from "../secrets.ts";
import { signedFetcher } from "../signing.ts";

/** A repo's `{owner}/{name}`, as the admin routes that take one name it. */
export const repoParams = (repo: string) => {
  const [owner, name, ...rest] = repo.split("/");
  if (!owner || !name || rest.length) throw new Error(`"${repo}" isn't owner/name`);
  return { owner, name };
};

/**
 * The router's admin routes, signed with the key the router and deployer
 * share. `url` is its public or private base URL. A refusal throws an
 * HttpError, e.g. `Router GET /installed: 401 bad signature`.
 */
export const routerAdmin = ({ url, key }: { url: string; key: string }) =>
  routeClient(routerAdminRoutes, signedFetcher(adminSecret(key), `${url.replace(/\/+$/, "")}/admin`), { service: "Router" });

export type RouterAdmin = ReturnType<typeof routerAdmin>;

/** The router's route for a container, signed with its container secret. */
export const routerForContainer = ({ url, secret }: { url: string; secret: string }) =>
  routeClient(routerContainerRoutes, signedFetcher(secret, url), { service: "Router" });

/** Sends each request to `base` with `token` as its bearer. */
const bearerFetcher =
  (token: string, base: string): RouteFetcher =>
  (path, { headers, ...init }) =>
    fetch(base + path, { ...init, headers: { ...headers, authorization: `Bearer ${token}` } });

/**
 * The router's public routes for the repo CLI, at `url`, as ACHQ_STATUS names
 * it: each answers only someone who can push to the repo, which `token`, your
 * code host token, proves. A refusal throws an HttpError, e.g. `Router
 * https://… POST /installation: 403 no push access`.
 */
export const routerForPusher = ({ url, token }: { url: string; token: string }) => {
  const root = url.replace(/\/+$/, "");
  const { wake, installation, deploy } = routerPublicRoutes;
  return routeClient({ wake, installation, deploy }, bearerFetcher(token, root), { service: `Router ${root}` });
};
