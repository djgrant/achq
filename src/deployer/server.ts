// The deployer's HTTP API (protocol.ts): every route but health is admin-signed.
import type { EventEnvelope, SyncRequest } from "../core/protocol.ts";
import { adminSecret, verifySigned } from "../core/secrets.ts";
import type { Deployer } from "./deployer.ts";

export const deployerHandler = (deployer: Deployer, key: string, log: (line: string) => void = console.error) => {
  const secret = adminSecret(key);
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/") return new Response("ok");
    const body = await req.text();
    if (!verifySigned(secret, req.method, url.pathname + url.search, body, req.headers)) return new Response("unauthorized", { status: 401 });
    const json = () => {
      try {
        return body ? JSON.parse(body) : {};
      } catch {
        return undefined;
      }
    };
    try {
      if (req.method === "POST" && url.pathname === "/events") {
        const envelope = json() as EventEnvelope | undefined;
        if (!envelope?.event || typeof envelope.event.delivery !== "string" || typeof envelope.event.type !== "string")
          return new Response("bad event", { status: 400 });
        // Answered once handled, so the router keeps the delivery until it's done.
        await deployer.handle(envelope);
        return new Response(null, { status: 202 });
      }
      if (req.method === "POST" && url.pathname === "/sync") {
        const request = json() as SyncRequest | undefined;
        if (!request) return new Response("bad request", { status: 400 });
        return Response.json(await deployer.sync({ prune: request.prune === true, dryRun: request.dryRun === true }));
      }
      if (req.method === "GET" && url.pathname === "/status") return Response.json(await deployer.status());
    } catch (error) {
      log(`deployer ${req.method} ${url.pathname}: ${error instanceof Error ? error.stack : String(error)}`);
      return new Response("internal error", { status: 500 });
    }
    return new Response("not found", { status: 404 });
  };
};
