import { crypto } from "@achq/utils/crypto";
import { type CreatedApp, GitHub } from "@achq/utils/gh";
import { GITHUB_API, GITHUB_WEB } from "./constants.ts";
import { APP_EVENTS, APP_PERMISSIONS } from "./permissions.ts";

const ACHQ_HOMEPAGE = "https://github.com/djgrant/achq";

/** The slug GitHub gives an App with this name. */
export const appSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Bytes of the `state` that ties GitHub's redirect back to this flow. */
const STATE_BYTES = 16;
/** What the process exits with on Ctrl-C: 128 + SIGINT. */
const SIGINT_EXIT = 130;
/** How long the server stays up after the flow ends, so the browser gets its last page. */
const LINGER_MS = 100;

export type ManifestRequest = { name: string; org?: string; hookUrl: string };

/**
 * `open` opens the local page in a browser; `githubWeb` and `githubApi` point tests at a fake.
 */
export const manifestFlow = async (
  request: ManifestRequest,
  options: { open: (url: string) => Promise<void> | void; githubWeb?: string; githubApi?: string },
) => {
  const web = options.githubWeb ?? GITHUB_WEB;
  const gh = GitHub.connect({ baseUrl: options.githubApi ?? GITHUB_API });
  const state = crypto.randomHex(STATE_BYTES);
  const { promise: created, resolve, reject } = Promise.withResolvers<CreatedApp>();

  const server = Bun.serve({
    port: 0,
    hostname: "localhost",
    // Typed, because it reads `server`, which it's part of.
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === "/") {
        // A page that posts the manifest to GitHub's new App form, which sends you back to `/callback`.
        const manifest = {
          name: request.name,
          url: ACHQ_HOMEPAGE,
          hook_attributes: { url: request.hookUrl, active: true },
          redirect_url: `http://localhost:${server.port}/callback`,
          // Without an org it's your account's, and public so others (orgs) can install it.
          public: !request.org,
          default_permissions: APP_PERMISSIONS,
          default_events: APP_EVENTS,
        };
        const action = `${web}${request.org ? `/organizations/${request.org}` : ""}/settings/apps/new?state=${state}`;
        const value = JSON.stringify(manifest).replace(/'/g, "&#39;");
        const page = `<form id="f" method="post" action="${action}"><input type="hidden" name="manifest" value='${value}'></form><script>f.submit()</script>`;
        return new Response(page, { headers: { "content-type": "text/html" } });
      }
      const code = url.searchParams.get("code");
      if (url.pathname !== "/callback" || !code || url.searchParams.get("state") !== state) return new Response("not found", { status: 404 });
      try {
        resolve(await gh.convertManifest(code));
        return new Response("App created. You can close this tab.");
      } catch (error) {
        reject(error);
        return new Response("Failed, see the terminal.");
      }
    },
  });
  const stop = () => {
    server.stop(true);
    process.exit(SIGINT_EXIT);
  };
  process.once("SIGINT", stop);
  try {
    await options.open(`http://localhost:${server.port}/`);
    return await created;
  } finally {
    process.off("SIGINT", stop);
    setTimeout(() => server.stop(), LINGER_MS);
  }
};
