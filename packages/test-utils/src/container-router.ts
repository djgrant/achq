import type { CredentialsResponse } from "@achq/core";
import { verifySigned } from "@achq/core/signing";

export const CHANNEL_TOKEN = "channel-token-never-for-agents";

/** The router's side of `/claims` and `/credentials`, checking container signatures. Mints `test-policy-provider` credentials. */
export const fakeRouter = (secret: string, opts: { expiresIn?: () => number; now?: () => number } = {}) => {
  const claims: unknown[] = [];
  const rejected: string[] = [];
  let mints = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      if (!verifySigned(secret, req.method, url.pathname, body, req.headers)) {
        rejected.push(url.pathname);
        return new Response("bad signature", { status: 401 });
      }
      if (url.pathname === "/claims") {
        claims.push(JSON.parse(body));
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/credentials") {
        mints++;
        const expiresAt = new Date((opts.now ?? Date.now)() + (opts.expiresIn?.() ?? 60 * 60_000)).toISOString();
        const response: CredentialsResponse = {
          credentials: [{ provider: "test-policy-provider", value: `agent-token-${mints}`, expiresAt, scope: {} }],
          channels: [{ channel: "test", value: CHANNEL_TOKEN, expiresAt, scope: { source: "app" } }],
        };
        return Response.json(response);
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://localhost:${server.port}`, claims, rejected, mints: () => mints, stop: () => server.stop(true) };
};
