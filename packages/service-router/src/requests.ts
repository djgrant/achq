import type { ClaimRequest, CredentialsRequest, MintRequest, RouterRepoConfig, ValidateRequest, WakeRequest } from "@achq/core";
import type { Schema } from "@achq/utils/http";
import { isPlainObject } from "@achq/utils/json";
import { REPO } from "./constants.ts";

type Fields = Record<string, unknown>;

// The router holds every App's key, so it stays small: plain checks, no zod.
const objectSchema = <T>(fits: (value: Fields) => boolean): Schema<T> => ({
  safeParse: (value) => (isPlainObject(value) && fits(value) ? { success: true, data: value as T } : { success: false }),
});

const isString = (value: unknown): value is string => typeof value === "string";

/** Only the shape: whether it's for the repo in the path is the route's to check. */
export const repoConfigSchema = objectSchema<RouterRepoConfig>(
  (c) => isString(c.host) && isString(c.repo) && isString(c.commit) && [c.containers, c.workspaces, c.triggers].every(Array.isArray),
);

export const policiesRequestSchema = objectSchema<MintRequest & ValidateRequest>((r) => isString(r.repo) && Array.isArray(r.policies));

export const wakeRequestSchema = objectSchema<WakeRequest>((r) => isString(r.host) && isString(r.repo) && REPO.test(r.repo) && isString(r.container));

/** Who a container says it is. The signature then proves it. */
export const containerIdentitySchema = objectSchema<CredentialsRequest>((r) => isString(r.repo) && isString(r.container));

export const claimRequestSchema = objectSchema<ClaimRequest>(
  (r) => isString(r.repo) && isString(r.container) && isPlainObject(r.thread) && isString(r.thread.channel) && isString(r.thread.id),
);
