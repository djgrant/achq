import { CONTAINER_PORT } from "@achq/core";
import { names } from "@achq/utils/names";
import { HOST_SERVICE_PREFIX, MAX_SERVICE_NAME, PRIVATE_DOMAIN } from "./constants.ts";

/** A Railway service name (and private hostname): lowercase letters, digits and dashes, at most 63 characters. */
export const serviceName = (...parts: string[]) => names.slug(parts, MAX_SERVICE_NAME);

export const hostServiceName = (resource: string) => serviceName(HOST_SERVICE_PREFIX, resource);

export const containerServiceName = (repo: string, name: string) => serviceName(repo.replace("/", "-"), name);

export const privateUrl = (service: string, port: number) => `http://${service}.${PRIVATE_DOMAIN}:${port}`;

export const containerUrl = (service: string) => privateUrl(service, CONTAINER_PORT);
