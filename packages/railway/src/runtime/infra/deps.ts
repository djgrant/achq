import type { RailwayClient } from "../../api.ts";

/** What the Railway expanders need from `achq up`. */
export type RailwayInfraDeps = {
  railway: RailwayClient;
  workspaceId?: string;
  /** The achq commit the router and deployer run. */
  ref: string;
  /** The deployer's tokens, kept in step with the CLI's environment. */
  tokens: { railway: string; claude: string };
  /** Makes AGENT_WEBHOOK_KEY, the first time. */
  newKey?: () => string;
  /** The router's public base URL from its domain; tests point it at a fake. */
  publicBase?: (domain: string) => string;
  sleep?: (ms: number) => Promise<void>;
  log: (line: string) => void;
};
