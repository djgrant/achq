import type { EventEnvelope } from "@achq/core";
import { verifySigned } from "@achq/core/signing";

/** The HTTP handler: `GET /` health, `POST /events` signed by the router. Accepted events go to `accept`, which mustn't block. */
export const eventsHandler = (opts: { secret: string; now: () => number; accept: (envelope: EventEnvelope) => void }) => async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/") return new Response("ok");
  if (req.method !== "POST" || url.pathname !== "/events") return new Response("not found", { status: 404 });
  const body = await req.text();
  if (!verifySigned(opts.secret, "POST", "/events", body, req.headers, opts.now())) {
    return new Response("bad signature", { status: 401 });
  }
  let envelope: EventEnvelope;
  try {
    envelope = JSON.parse(body);
    if (!envelope?.event?.delivery) throw new Error("no delivery");
  } catch {
    return new Response("bad request", { status: 400 });
  }
  opts.accept(envelope);
  return new Response("accepted", { status: 202 });
};
