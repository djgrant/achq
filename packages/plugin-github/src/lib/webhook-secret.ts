import { implementationSecret } from "@achq/core/secrets";

/** An App's webhook secret, from its App ID (sent in X-GitHub-Hook-Installation-Target-ID). */
export const appWebhookSecret = (key: string, appId: string | number) => implementationSecret(key, `github-app-webhook:${appId}`);
