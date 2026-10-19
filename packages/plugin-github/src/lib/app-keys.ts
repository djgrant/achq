/** `{ [slug]: { id, privateKey } }`, from ACHQ_GITHUB_APPS. */
export type AppKeys = Record<string, { id: string; privateKey: string }>;

/** Reads ACHQ_GITHUB_APPS. */
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

/** ACHQ_GITHUB_APPS' JSON, stable, so the same Apps always make the same variable. */
export const appsVariable = (apps: AppKeys) => JSON.stringify(Object.fromEntries(Object.entries(apps).sort(([a], [b]) => a.localeCompare(b))));
