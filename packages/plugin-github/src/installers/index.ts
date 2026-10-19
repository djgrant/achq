import type { Installer } from "@achq/core";
import { CHANNEL } from "../lib/constants.ts";
import { AppInstallation } from "../resources/app-installation.ts";
import { configApp, configNeeds } from "./config-app.ts";

/** Installs the config's one App on the repo. */
export const githubInstaller: Installer = {
  id: CHANNEL,
  installation(repo, manifest, installed) {
    const slug = configApp(manifest);
    return [new AppInstallation({ slug, repo, installed, needs: configNeeds(manifest, slug) })];
  },
};
