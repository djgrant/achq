import { createSign } from "node:crypto";

/** GitHub accepts App JWTs for at most ten minutes; nine leaves room for clock drift. */
const JWT_LIFETIME_S = 600;
/** Issued a minute in the past, in case GitHub's clock is behind. */
const CLOCK_SKEW_S = 60;

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A JWT that authenticates as the GitHub App itself, valid for nine minutes from `now`. */
export const appJwt = (appId: string | number, privateKey: string, now = Date.now()): string => {
  const iat = Math.floor(now / 1000) - CLOCK_SKEW_S;
  const unsigned = `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url({ iat, exp: iat + JWT_LIFETIME_S, iss: String(appId) })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url")}`;
};
