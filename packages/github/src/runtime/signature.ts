import { hmacHex, safeEqual } from "@achq/core/signing";

/** Checks GitHub's X-Hub-Signature-256 header against the raw body. */
export const verifyGitHubSignature = (secret: string, body: string, header: string | null) =>
  Boolean(header?.startsWith("sha256=")) && safeEqual(header!, `sha256=${hmacHex(secret, body)}`);
