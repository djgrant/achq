/**
 * Never handed to an agent. The container secret proves the container's
 * identity to the router (it could mint every credential the container has,
 * and post as the channel); the rest only exist on the router or deployer,
 * listed in case an image or a misconfigured service sets them.
 */
export const PRIVATE_ENV = [
  "ACHQ_CONTAINER_SECRET",
  "AGENT_WEBHOOK_KEY",
  "ACHQ_GITHUB_APPS",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_APP_ID",
  "RAILWAY_TOKEN",
];

export const withoutPrivate = (env: Record<string, string | undefined>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !PRIVATE_ENV.includes(k)) out[k] = v;
  return out;
};
