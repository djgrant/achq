import { routerContainerRoutes as routes } from "@achq/core/routes/router-container";
import { verifySigned } from "@achq/core/signing";
import { OpenAPIHono } from "@hono/zod-openapi";

export const CHANNEL_TOKEN = "channel-token-never-for-agents";

/** The router's side of `/credentials`, as `@achq/core/routes/router-container` declares it, checking container signatures. Mints `test-policy-provider` credentials. */
export const fakeRouter = (secret: string, opts: { expiresIn?: () => number; now?: () => number } = {}) => {
  const rejected: string[] = [];
  let mints = 0;
  const app = new OpenAPIHono();
  app.use(async (c, next) => {
    const { pathname } = new URL(c.req.url);
    if (!verifySigned(secret, c.req.method, pathname, await c.req.text(), c.req.raw.headers)) {
      rejected.push(pathname);
      return c.text("bad signature", 401);
    }
    await next();
  });
  app.openapi(routes.credentials, (c) => {
    mints++;
    const expiresAt = new Date((opts.now ?? Date.now)() + (opts.expiresIn?.() ?? 60 * 60_000)).toISOString();
    return c.json(
      {
        credentials: [{ provider: "test-policy-provider", value: `agent-token-${mints}`, expiresAt, scope: {} }],
        channels: [{ channel: "test", value: CHANNEL_TOKEN, expiresAt, scope: { source: "app" } }],
      },
      200,
    );
  });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  return { url: `http://localhost:${server.port}`, rejected, mints: () => mints, stop: () => server.stop(true) };
};
