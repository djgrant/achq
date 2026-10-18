/** `{ [slug]: { id, privateKey } }`, from ENV.githubApps. */
export type AppKeys = Record<string, { id: string; privateKey: string }>;

/** Reads ENV.githubApps' JSON. */
export const parseApps = (json: string | undefined): AppKeys => {
  if (!json) return {};
  const parsed = JSON.parse(json);
  for (const [slug, app] of Object.entries<any>(parsed)) {
    if (!app || typeof app.privateKey !== "string" || (typeof app.id !== "string" && typeof app.id !== "number")) {
      throw new Error(`GitHub App "${slug}" needs an id and a privateKey`);
    }
  }
  return Object.fromEntries(Object.entries<any>(parsed).map(([slug, a]) => [slug, { id: String(a.id), privateKey: a.privateKey }]));
};
