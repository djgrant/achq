import { createHash } from "node:crypto";
import { CONTAINER_PORT } from "@achq/core";
import { HOST_SERVICE_PREFIX, MAX_SERVICE_NAME, PRIVATE_DOMAIN } from "../constants.ts";

/** A Railway service name (and private hostname): lowercase letters, digits and dashes, at most 63 characters. */
export const serviceName = (...parts: string[]) => {
  const name = parts
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (name.length <= MAX_SERVICE_NAME) return name;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${name.slice(0, MAX_SERVICE_NAME - 9).replace(/-$/, "")}-${hash}`;
};

/** The service a router or deployer resource runs as. */
export const hostServiceName = (resource: string) => serviceName(HOST_SERVICE_PREFIX, resource);

export const containerServiceName = (repo: string, name: string) => serviceName(repo.replace("/", "-"), name);

export const privateUrl = (service: string, port: number) => `http://${service}.${PRIVATE_DOMAIN}:${port}`;

export const containerUrl = (service: string) => privateUrl(service, CONTAINER_PORT);
