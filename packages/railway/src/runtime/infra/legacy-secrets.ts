// Before secrets moved to shared variables, the router's own variables held
// AGENT_WEBHOOK_KEY and every App's credential. Finding them here lets the
// first `up` since then move them, rather than make a new key (which would
// break every App's webhook secret) and new Apps. Remove once every infra has
// run it.
import { ENV, githubAppVariable } from "@achq/core";
import type { RailwayClient } from "../../api.ts";
import { LEGACY_GITHUB_APPS } from "../../constants.ts";
import type { Place } from "../resources/project.ts";

const isValue = (v: string | undefined): v is string => v !== undefined && !v.includes("${{");

const legacyApps = (json: string | undefined): Record<string, { id: string | number; privateKey: string }> => {
  try {
    const parsed = JSON.parse(json ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

/** Finds a secret by its shared variable's name in the router's variables, where it used to be kept. */
export const legacyRouterSecrets = (railway: RailwayClient, place: Place, routerService: string) => {
  let read: Promise<Record<string, string>> | undefined;
  const routerVariables = () =>
    (read ??= (async (): Promise<Record<string, string>> => {
      const found = (await railway.project(place.projectId)).services.find((s) => s.name === routerService);
      return found ? railway.variables(place.projectId, place.environmentId, found.id, { unrendered: true }) : {};
    })());

  return async (name: string) => {
    const old = await routerVariables();
    if (name === ENV.key) return isValue(old[ENV.key]) ? old[ENV.key] : undefined;
    for (const [slug, app] of Object.entries(legacyApps(old[LEGACY_GITHUB_APPS]))) {
      if (githubAppVariable(slug) === name) return JSON.stringify({ slug, id: String(app.id), privateKey: app.privateKey });
    }
    return undefined;
  };
};
