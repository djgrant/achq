// What an achq Worker is told about itself, in its ACHQ_SERVICE variable. The
// plugin writes it into each Worker's config; the Worker reads it. Plain data,
// imported by both sides, so it imports nothing.

/** Where achq's Workers reach each other, from their containers: `http://<port>.<worker>.achq.internal`. */
export const INTERNAL_DOMAIN = "achq.internal";

/** Hostnames under INTERNAL_DOMAIN that a container's own Worker answers, rather than another Worker. */
export const INTERNAL_HOSTS = {
  /** A JSON store in the Worker's Durable Object: ENV.storeUrl. */
  store: `store.${INTERNAL_DOMAIN}`,
  /** Fetched while the container works, so its Worker doesn't put it to sleep: ENV.keepAwakeUrl. */
  awake: `awake.${INTERNAL_DOMAIN}`,
  /** The container's archive of its /data in R2, for moving to a new image and recovering a lost snapshot. */
  archive: `archive.${INTERNAL_DOMAIN}`,
} as const;

/** One Worker hop to another carries the account's internal key, and the port it's for. */
export const HEADERS = { key: "x-achq-internal-key", port: "x-achq-port" } as const;

/** The image the router and deployer run: Cloudflare's own, so nothing is built for them. It has Node, and gets Bun on its first start. */
export const MANAGED_IMAGE = "cloudflare/debian-trixie";

/** A container's image, built from its repo's Dockerfile, by this name in its Worker's config. */
export const APP_IMAGE = "app";

/** Where a container keeps what outlives a restart: in its snapshots, and its archive. */
export const DATA_DIR = "/data";

export type WorkerSettings = {
  /** Its Worker's name, which other Workers' containers reach it by. */
  name: string;
  /** The port its container serves, health-checked on `/`. */
  port: number;
  /** The port public requests go to. Without one, only achq's own Workers reach it. */
  publicPort?: number;
  /** Snapshotted and stopped once idle; started by the next request. */
  sleeps: boolean;
  /** Restarted with the new variables or image as soon as its Worker changes, as a service redeploys. A container picks them up when it next starts. */
  restartOnChange: boolean;
  /** MANAGED_IMAGE, or APP_IMAGE. */
  image: string;
  /** Instead of the image's own command. */
  entrypoint?: string[];
  /** A Cloudflare instance type: `lite` is too small for a 2 GB image. */
  instance: string;
  /** `<subdomain>.workers.dev`: where every achq Worker on the account is. */
  workersDev: string;
};

/** Every achq Worker reaches the others over their workers.dev URLs, carrying the internal key, so it needs a global fetch that leaves Cloudflare. */
export const COMPATIBILITY = { date: "2026-10-19", flags: ["global_fetch_strictly_public"] };

/** The Durable Object class that runs a Worker's container, and the one instance of it. */
export const SERVICE_CLASS = "Service";
export const SERVICE_INSTANCE = "service";
