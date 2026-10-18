import { ENV, type InfraPlatform } from "@achq/core";
import { adminSecret } from "@achq/core/secrets";
import { signedFetch } from "@achq/core/signing";

export type RouterAccess = { base: string; key: string };

/** The router's public URL and AGENT_WEBHOOK_KEY, read from where it runs. */
export const routerAccess = async (platform: InfraPlatform, routerName: string): Promise<RouterAccess> => {
  const router = await platform.current(routerName);
  if (!router) throw new Error(`There's no router ${routerName}. Run \`achq up\`.`);
  const key = router.env[ENV.key];
  if (!key || !router.publicUrl) throw new Error(`Router ${routerName} isn't set up. Run \`achq up\`.`);
  return { base: router.publicUrl, key };
};

/** An admin-signed request to the router. Throws on anything but 2xx. */
export const adminRequest = async <T>(router: RouterAccess, method: string, path: string, body?: unknown): Promise<T> => {
  const res = await signedFetch(adminSecret(router.key), router.base + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Router ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : undefined) as T;
};
