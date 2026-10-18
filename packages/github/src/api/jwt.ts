import { createSign } from "node:crypto";

/** A JWT that authenticates as the GitHub App itself, valid for nine minutes. */
export const appJwt = (appId: string | number, privateKey: string, now = Date.now()): string => {
  const iat = Math.floor(now / 1000) - 60;
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat, exp: iat + 600, iss: String(appId) })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url")}`;
};
