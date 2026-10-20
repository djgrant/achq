// GitHub's App manifest flow. A local page posts the manifest to GitHub from
// your browser. GitHub redirects back with a code, which converts into the
// App's credentials. They stay in memory.
import { randomHex } from "@achq/utils/crypto";
import type { CreatedApp } from "@achq/utils/gh";
import { github } from "./client.ts";
import { GITHUB_API, GITHUB_WEB } from "./constants.ts";
import { APP_EVENTS, APP_PERMISSIONS } from "./permissions.ts";

const ACHQ_HOMEPAGE = "https://github.com/djgrant/achq";

/** The slug GitHub gives an App with this name. */
export const appSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export type { CreatedApp };

/** Bytes of the `state` that ties GitHub's redirect back to this flow. */
const STATE_BYTES = 16;
/** What the process exits with on Ctrl-C: 128 + SIGINT. */
const SIGINT_EXIT = 130;
/** How long the server stays up after the flow ends, so the browser gets its last page. */
const LINGER_MS = 100;

export type ManifestRequest = { name: string; org?: string; hookUrl: string };

export const appManifest = (request: ManifestRequest, redirectUrl: string) => ({
  name: request.name,
  url: ACHQ_HOMEPAGE,
  hook_attributes: { url: request.hookUrl, active: true },
  redirect_url: redirectUrl,
  // Without an org it's your account's, and public so others (orgs) can install it.
  public: !request.org,
  default_permissions: APP_PERMISSIONS,
  default_events: APP_EVENTS,
});

const manifestPage = (action: string, manifest: object) => {
  const value = JSON.stringify(manifest).replace(/'/g, "&#39;");
  return `<form id="f" method="post" action="${action}"><input type="hidden" name="manifest" value='${value}'></form><script>f.submit()</script>`;
};

const newAppUrl = (web: string, org: string | undefined, state: string) => `${web}${org ? `/organizations/${org}` : ""}/settings/apps/new?state=${state}`;

const html = (page: string) => new Response(page, { headers: { "content-type": "text/html" } });

/**
 * `open` opens the local page in a browser; `githubWeb` and `githubApi` point tests at a fake.
 */
export const manifestFlow = async (
  request: ManifestRequest,
  options: { open: (url: string) => Promise<void> | void; githubWeb?: string; githubApi?: string },
): Promise<CreatedApp> => {
  const web = options.githubWeb ?? GITHUB_WEB;
  const gh = github("", options.githubApi ?? GITHUB_API);
  const state = randomHex(STATE_BYTES);
  let settle!: { resolve: (app: CreatedApp) => void; reject: (e: Error) => void };
  const created = new Promise<CreatedApp>((resolve, reject) => (settle = { resolve, reject }));

  const convert = async (code: string) => {
    try {
      settle.resolve(await gh.convertManifest(code));
      return new Response("App created. You can close this tab.");
    } catch (error) {
      settle.reject(error as Error);
      return new Response("Failed, see the terminal.");
    }
  };

  const server = Bun.serve({
    port: 0,
    hostname: "localhost",
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === "/") return html(manifestPage(newAppUrl(web, request.org, state), appManifest(request, `http://localhost:${server.port}/callback`)));
      const code = url.searchParams.get("code");
      if (url.pathname !== "/callback" || !code || url.searchParams.get("state") !== state) return new Response("not found", { status: 404 });
      return convert(code);
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
