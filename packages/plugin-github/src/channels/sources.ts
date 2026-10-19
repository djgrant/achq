import type { SourceSettings } from "@achq/core";
import { CHANNEL } from "../lib/constants.ts";
import type { Apps } from "../lib/apps.ts";

/** What each App is set up to send and allow, read as the App. */
export const sources = async (apps: Apps): Promise<SourceSettings[]> =>
  Promise.all(
    apps.slugs().map(async (slug) => {
      const app = await apps.asApp(slug).request<{ events?: string[]; permissions?: Record<string, string> }>("GET", "/app");
      return { channel: CHANNEL, source: slug, events: app.events ?? [], permissions: app.permissions ?? {} };
    }),
  );
