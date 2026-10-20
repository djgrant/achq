// Every route but health must be admin-signed (see core's protocol.ts).
import type { DeployerEnvelope } from "@achq/core";
import { verifyAdminRequest } from "@achq/core/signing";
import { jsonResponse, parseBody, textResponse, withHealthAndErrors } from "@achq/utils/http";
import { z } from "zod";
import type { Deployer } from "./deployer.ts";

/** What the deployer needs of an event to handle it. The rest passes through as it came. */
const envelopeSchema = z.object({ event: z.looseObject({ delivery: z.string(), type: z.string(), host: z.string() }) });

const syncRequestSchema = z.object({ prune: z.boolean().optional(), dryRun: z.boolean().optional() });

type Route = (deployer: Deployer, body: string) => Promise<Response>;

const handleEvent: Route = async (deployer, body) => {
  const envelope = parseBody(envelopeSchema, body);
  if (!envelope) return textResponse("bad event", 400);
  // Answered once handled, so the router keeps the delivery until it's done.
  await deployer.handle({ event: envelope.event as DeployerEnvelope["event"] });
  return new Response(null, { status: 202 });
};

const runSync: Route = async (deployer, body) => {
  const request = parseBody(syncRequestSchema, body);
  if (!request) return textResponse("bad request", 400);
  return jsonResponse(await deployer.sync({ prune: request.prune ?? false, dryRun: request.dryRun ?? false }));
};

/** By `<method> <path>`. */
const ROUTES = new Map<string, Route>([
  ["POST /events", handleEvent],
  ["POST /sync", runSync],
  ["GET /status", async (deployer) => jsonResponse(await deployer.status())],
]);

export const deployerHandler = (deployer: Deployer, key: string, log: (line: string) => void = console.error) =>
  withHealthAndErrors(
    async (req, url) => {
      const verified = await verifyAdminRequest(req, key);
      if (!verified) return textResponse("bad signature", 401);
      return ROUTES.get(`${req.method} ${url.pathname}`)?.(deployer, verified.body);
    },
    (line) => log(`deployer ${line}`),
  );
