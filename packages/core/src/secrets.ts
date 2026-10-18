// Every secret derives from AGENT_WEBHOOK_KEY. Each derivation has its own
// label, so no two collide.
import { createHmac } from "node:crypto";

const derive = (key: string, label: string) => createHmac("sha256", key).update(label).digest("hex");

/** A GitHub App's webhook secret, from its App ID (sent in X-GitHub-Hook-Installation-Target-ID). */
export const appWebhookSecret = (key: string, appId: string | number) => derive(key, `github-app-webhook:${appId}`);

/** A container signs its requests to the router with this. The router signs events to the container with it too. */
export const containerSecret = (key: string, repo: string, container: string) =>
  derive(key, `container:${repo.toLowerCase()}:${container}`);

/** Signs requests between the router, the deployer and the infra CLI. */
export const adminSecret = (key: string) => derive(key, "admin");
