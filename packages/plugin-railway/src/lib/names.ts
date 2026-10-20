import { CONTAINER_PORT } from "@achq/core";
import { sha256Hex } from "@achq/utils/crypto";
import { HOST_SERVICE_PREFIX, MAX_SERVICE_NAME, PRIVATE_DOMAIN } from "./constants.ts";

/** A Railway service name (and private hostname): lowercase letters, digits and dashes, at most 63 characters. */
export const serviceName = (...parts: string[]) => {
  const name = parts
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return name.length <= MAX_SERVICE_NAME ? name : shortened(name);
};

/** How much of a too-long name's hash tells it apart from others cut to the same prefix. */
const NAME_HASH_CHARS = 8;

/** A name cut to fit, ending in a hash of the whole of it. */
const shortened = (name: string) => {
  const prefix = name.slice(0, MAX_SERVICE_NAME - NAME_HASH_CHARS - 1).replace(/-$/, "");
  return `${prefix}-${sha256Hex(name, NAME_HASH_CHARS)}`;
};

/** The service a router or deployer resource runs as. */
export const hostServiceName = (resource: string) => serviceName(HOST_SERVICE_PREFIX, resource);

export const containerServiceName = (repo: string, name: string) => serviceName(repo.replace("/", "-"), name);

export const privateUrl = (service: string, port: number) => `http://${service}.${PRIVATE_DOMAIN}:${port}`;

export const containerUrl = (service: string) => privateUrl(service, CONTAINER_PORT);
