// GitHub's App manifest flow. A local page posts the manifest to GitHub from
// your browser. GitHub redirects back with a code, which converts into the
// App's credentials. They stay in memory.
import { randomBytes } from "node:crypto";
import { ACHQ_HOMEPAGE, APP_EVENTS, APP_PERMISSIONS, GITHUB_API, GITHUB_WEB, USER_AGENT } from "../constants.ts";

export type CreatedApp = { id: number; slug: string; pem: string; html_url: string };

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

/**
 * Creates an App through the manifest flow. `open` opens the local page in a
 * browser; `githubWeb` and `githubApi` point tests at a fake.
 */
export const manifestFlow = async (
  request: ManifestRequest,
  options: { open: (url: string) => Promise<void> | void; githubWeb?: string; githubApi?: string },
): Promise<CreatedApp> => {
  const web = options.githubWeb ?? GITHUB_WEB;
  const api = options.githubApi ?? GITHUB_API;
  const state = randomBytes(16).toString("hex");
  let settle!: { resolve: (app: CreatedApp) => void; reject: (e: Error) => void };
  const created = new Promise<CreatedApp>((resolve, reject) => (settle = { resolve, reject }));

  const server = Bun.serve({
    port: 0,
    hostname: "localhost",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/") {
        const manifest = appManifest(request, `http://localhost:${server.port}/callback`);
        const action = `${web}${request.org ? `/organizations/${request.org}` : ""}/settings/apps/new?state=${state}`;
        const page = `<form id="f" method="post" action="${action}"><input type="hidden" name="manifest" value='${JSON.stringify(manifest).replace(/'/g, "&#39;")}'></form><script>f.submit()</script>`;
        return new Response(page, { headers: { "content-type": "text/html" } });
      }
      const code = url.searchParams.get("code");
      if (url.pathname !== "/callback" || !code || url.searchParams.get("state") !== state) return new Response("not found", { status: 404 });
      const res = await fetch(`${api}/app-manifests/${code}/conversions`, {
        method: "POST",
        headers: { accept: "application/vnd.github+json", "user-agent": USER_AGENT },
      });
      if (!res.ok) {
        settle.reject(new Error(`GitHub: ${res.status} ${await res.text()}`));
        return new Response("Failed, see the terminal.");
      }
      settle.resolve((await res.json()) as CreatedApp);
      return new Response("App created. You can close this tab.");
    },
  });
  const stop = () => {
    server.stop(true);
    process.exit(130);
  };
  process.once("SIGINT", stop);
  try {
    await options.open(`http://localhost:${server.port}/`);
    return await created;
  } finally {
    process.off("SIGINT", stop);
    setTimeout(() => server.stop(), 100);
  }
};
