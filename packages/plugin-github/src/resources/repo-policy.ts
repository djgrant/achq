import { Policy } from "@achq/core";
import { ACCESS } from "../lib/constants.ts";
import type { AppRef } from "../channels/app-ref.ts";

export type Permission = "read" | "write";

export type RepoPolicyData = {
  access: typeof ACCESS;
  app: string;
  /** `owner/name`, or null for the repo the config is in. */
  repo: string | null;
  permissions: Record<string, Permission>;
};

/** Access to one repo through an App's installation. Defaults to the config's own repo. */
export class RepoPolicy extends Policy {
  constructor(name: string, inputs: { app: AppRef; repo?: string; permissions: Record<string, Permission> }) {
    const data: RepoPolicyData = { access: ACCESS, app: inputs.app.slug, repo: inputs.repo ?? null, permissions: inputs.permissions };
    super(name, data);
  }
}
