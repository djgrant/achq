import { defineCommand } from "@pokit/core";
import { $ } from "bun";
import { z } from "zod";
import { AGENT_SECRETS_FILE, saveSecret } from "../lib/agent.ts";

const PORT = 3171;

export const command = defineCommand({
  label: "Create the GitHub App the GitHub agent acts as",
  examples: ["ak agent app --org notationlabs"],
  context: {
    name: {
      from: "flag",
      schema: z.string().default("agentkit-github-agent"),
      description: "App name, unique across GitHub",
    },
    org: {
      from: "flag",
      schema: z.string().optional(),
      description: "Organisation to own the App (default: your account, as a public App so orgs can install it)",
    },
  },
  run: async (r, { context }) => {
    // GitHub's manifest flow: post the manifest from a browser, GitHub redirects
    // back with a code, and the code converts into the App's credentials.
    const manifest = {
      name: context.name,
      url: "https://github.com/djgrant/agentkit",
      // Each repo's service gets its own repo webhook; the App only mints tokens.
      hook_attributes: { url: "https://example.com", active: false },
      redirect_url: `http://localhost:${PORT}/callback`,
      public: !context.org,
      default_permissions: { contents: "write", issues: "write", pull_requests: "write", metadata: "read" },
      default_events: [],
    };
    const action = context.org
      ? `https://github.com/organizations/${context.org}/settings/apps/new`
      : "https://github.com/settings/apps/new";
    const page = `<form id="f" method="post" action="${action}"><input type="hidden" name="manifest" value='${JSON.stringify(manifest).replace(/'/g, "&#39;")}'></form><script>f.submit()</script>`;

    const app = new Promise<{ id: number; slug: string; pem: string; html_url: string }>((resolve, reject) => {
      const server = Bun.serve({
        port: PORT,
        async fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/") return new Response(page, { headers: { "content-type": "text/html" } });
          const code = url.searchParams.get("code");
          if (url.pathname !== "/callback" || !code) return new Response("not found", { status: 404 });
          const res = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
            method: "POST",
            headers: { accept: "application/vnd.github+json", "user-agent": "agentkit" },
          });
          setTimeout(() => server.stop(), 100);
          if (!res.ok) {
            reject(new Error(`GitHub: ${res.status} ${await res.text()}`));
            return new Response("Failed, see the terminal.");
          }
          resolve((await res.json()) as { id: number; slug: string; pem: string; html_url: string });
          return new Response("App created. You can close this tab.");
        },
      });
      // Bun.serve keeps the process alive, so Ctrl+C has to stop it.
      process.once("SIGINT", () => {
        server.stop(true);
        process.exit(130);
      });
    });

    r.reporter.info(`Opening http://localhost:${PORT} to create the App on GitHub…`);
    await $`open ${`http://localhost:${PORT}`}`.quiet().nothrow();

    const created = await app;
    saveSecret("GITHUB_APP_ID", String(created.id));
    saveSecret("GITHUB_APP_SLUG", created.slug);
    saveSecret("GITHUB_APP_PRIVATE_KEY", created.pem);
    r.reporter.success(`Created ${created.html_url} and saved its credentials to ${AGENT_SECRETS_FILE}`);
    r.reporter.info(`Install it on each repo the agent should work on: https://github.com/apps/${created.slug}/installations/new`);
  },
});
