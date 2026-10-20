import type { ContainerEnvelope } from "@achq/core";
import { verifySignedRequest } from "@achq/core/signing";
import { parseObject, textResponse } from "@achq/utils/http";

export type EventsHandlerOptions = {
  secret: string;
  now: () => number;
  /** Mustn't block: the router waits for the response. */
  accept: (envelope: ContainerEnvelope) => void;
};

/** The HTTP handler: `GET /` health, `POST /events` signed by the router. */
export const eventsHandler = (opts: EventsHandlerOptions) => async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/") return textResponse("ok");
  if (req.method !== "POST" || url.pathname !== "/events") return textResponse("not found", 404);
  const signed = await verifySignedRequest(req, opts.secret, opts.now());
  if (!signed) return textResponse("bad signature", 401);
  const envelope = parseEnvelope(signed.body);
  if (!envelope) return textResponse("bad request", 400);
  opts.accept(envelope);
  return textResponse("accepted", 202);
};

const parseEnvelope = (body: string): ContainerEnvelope | undefined => {
  const envelope = parseObject<ContainerEnvelope>(body);
  if (!envelope?.event?.delivery || typeof envelope.commit !== "string") return undefined;
  return envelope as ContainerEnvelope;
};
