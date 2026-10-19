import type { RepoPlan } from "@achq/core";
import type { GitHubClient } from "../lib/client.ts";
import { covers } from "../lib/permissions.ts";
import { configNeeds } from "./config-app.ts";

export type AppCheck = { private: true } | { private: false; missing: string[] };

/** Compares the live App with what the config needs. A private App is a 404, even to its owner. */
export const checkApp = async (gh: GitHubClient, slug: string, plan: RepoPlan): Promise<AppCheck> => {
  const res = await gh.raw("GET", `/apps/${slug}`);
  if (res.status === 404) return { private: true };
  if (!res.ok) throw new Error(`GET /apps/${slug}: ${res.status} ${await res.text()}`);
  const app = (await res.json()) as { events: string[]; permissions: Record<string, string> };
  const needs = configNeeds(plan, slug);
  return {
    private: false,
    missing: [
      ...needs.events.filter((e) => !app.events.includes(e)).map((e) => `the ${e} event`),
      ...Object.entries(needs.permissions)
        .filter(([name, level]) => !covers(app.permissions[name], level))
        .map(([name, level]) => `${name}: ${level}`),
    ],
  };
};
