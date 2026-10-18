import { ENV } from "@achq/core";

/** Each App's ID and private key, by slug. */
export type AppKeys = Record<string, { id: string; privateKey: string }>;

/** One App's credential, `{ slug, id, privateKey }` as JSON. */
export const parseAppCredential = (variable: string, json: string) => {
  const app = JSON.parse(json);
  if (!app || typeof app.slug !== "string" || typeof app.privateKey !== "string" || (typeof app.id !== "string" && typeof app.id !== "number")) {
    throw new Error(`${variable} needs a slug, an id and a privateKey`);
  }
  return { slug: app.slug as string, id: String(app.id), privateKey: app.privateKey as string };
};

/** Every App's credential, from the variables starting with ENV.githubAppPrefix. */
export const parseApps = (env: Record<string, string | undefined>): AppKeys => {
  const apps: AppKeys = {};
  for (const [variable, json] of Object.entries(env)) {
    if (!variable.startsWith(ENV.githubAppPrefix) || !json) continue;
    const { slug, id, privateKey } = parseAppCredential(variable, json);
    apps[slug] = { id, privateKey };
  }
  return apps;
};
