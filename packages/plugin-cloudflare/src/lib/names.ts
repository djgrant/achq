import { CONTAINER_PORT } from "@achq/core";
import { names } from "@achq/utils/names";
import { INTERNAL_DOMAIN } from "../../worker/settings.ts";
import { MAX_WORKER_NAME } from "./constants.ts";

/** A Worker name (and workers.dev hostname): lowercase letters, digits and dashes, at most 63 characters. */
export const workerName = (...parts: string[]) => names.slug(parts, MAX_WORKER_NAME);

/** Worker names are the account's, so each is its project's: the router of project `achq` is `achq-router`. */
export const serviceWorkerName = (project: string, resource: string) => workerName(project, resource);

export const containerWorkerName = (project: string, repo: string, name: string) => workerName(project, repo.replace("/", "-"), name);

/** Where achq's other Workers' containers reach a Worker's container on `port`: through their own Worker, which passes it on. */
export const privateUrl = (worker: string, port: number) => `http://${port}.${worker}.${INTERNAL_DOMAIN}`;

export const containerUrl = (worker: string) => privateUrl(worker, CONTAINER_PORT);

/** Where a Worker is public, on the account's `<subdomain>.workers.dev`. */
export const publicUrl = (worker: string, workersDev: string) => `https://${worker}.${workersDev}`;

/** Keys in the project's KV namespace. */
export const KV_KEYS = {
  /** A service's variables, as JSON: what's set, readable, as Railway's are. */
  service: (worker: string) => `services/${worker}`,
  /** A container's variables, as JSON. */
  container: (worker: string) => `containers/${worker}`,
  containers: "containers/",
  /** A hash of what a Worker was last deployed with, or its secrets last set from. */
  deployed: (worker: string) => `deployed/${worker}`,
};

/** A container's archive of its /data, in the project's R2 bucket. */
export const archiveKey = (worker: string) => `${worker}/data.tar.gz`;
