import { type Context, ENV, known, plan } from "@achq/core";
import { adminSecret } from "@achq/core/secrets";
import { signedFetch } from "@achq/core/signing";
import { HttpError } from "@achq/utils/http";
import type { InfraResources } from "./load/infra.ts";

export type RouterAccess = { base: string; key: string };

/** The router's public URL and AGENT_WEBHOOK_KEY, read from where it runs. Plans the router, so changes nothing. */
export const routerAccess = async ({ router }: InfraResources, ctx: Context): Promise<RouterAccess> => {
  const planned = await plan([router], ctx);
  const env = planned.value(router.env);
  const url = planned.value(router.url);
  if (!known(env) || !Object.keys(env).length) throw new Error(`There's no router ${router.name}. Run \`achq infra up\`.`);
  const key = env[ENV.key];
  if (!key || !known(url)) throw new Error(`Router ${router.name} isn't set up. Run \`achq infra up\`.`);
  return { base: url, key };
};

const jsonBody = (body: unknown) => (body === undefined ? undefined : JSON.stringify(body));

const parseJsonText = (text: string): unknown => (text ? JSON.parse(text) : undefined);

/** Throws on anything but 2xx. */
export const adminRequest = async <T>(router: RouterAccess, method: string, path: string, body?: unknown): Promise<T> => {
  const res = await signedFetch(adminSecret(router.key), router.base + path, { method, body: jsonBody(body) });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, method, path, text, "Router");
  return parseJsonText(text) as T;
};
