import { ContainerEnvelope } from "@achq/core/protocol";
import { signedBy } from "@achq/core/signing";
import { http } from "@achq/utils/http";
import { zValidator } from "@hono/zod-validator";

export type EventsHandlerOptions = {
  secret: string;
  now: () => number;
  /** Mustn't block: the router waits for the response. */
  accept: (envelope: ContainerEnvelope) => void;
  log: (line: string) => void;
};

/** Events the router signed. */
export const eventsHandler = (opts: EventsHandlerOptions) =>
  http.service(opts.log).post("/events", signedBy(opts.secret, opts.now), zValidator("json", ContainerEnvelope), (c) => {
    opts.accept(c.req.valid("json"));
    return c.text("accepted", 202);
  }).fetch;
