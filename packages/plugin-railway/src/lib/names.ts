import { CONTAINER_PORT } from "@achq/core";
import { crypto } from "@achq/utils/crypto";
import { HOST_SERVICE_PREFIX, MAX_SERVICE_NAME, PRIVATE_DOMAIN } from "./constants.ts";

/** How much of a too-long name's hash tells it apart from others cut to the same prefix. */
const NAME_HASH_CHARS = 8;

/** A Railway service name (and private hostname): lowercase letters, digits and dashes, at most 63 characters. */
export const serviceName = (...parts: string[]) => {
  const name = parts
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (name.length <= MAX_SERVICE_NAME) return name;
  // Cut to fit, ending in a hash of the whole of it.
  const prefix = name.slice(0, MAX_SERVICE_NAME - NAME_HASH_CHARS - 1).replace(/-$/, "");
  return `${prefix}-${crypto.sha256Hex(name, NAME_HASH_CHARS)}`;
};

export const hostServiceName = (resource: string) => serviceName(HOST_SERVICE_PREFIX, resource);

export const containerServiceName = (repo: string, name: string) => serviceName(repo.replace("/", "-"), name);

export const privateUrl = (service: string, port: number) => `http://${service}.${PRIVATE_DOMAIN}:${port}`;

export const containerUrl = (service: string) => privateUrl(service, CONTAINER_PORT);
