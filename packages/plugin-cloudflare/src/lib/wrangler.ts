import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { crypto } from "@achq/utils/crypto";
import { Env, type Vars } from "@achq/utils/env";
import { subprocess } from "@achq/utils/subprocess";
import { text } from "@achq/utils/text";
import { COMPATIBILITY, SERVICE_CLASS, VERSION_BINDING, type WorkerSettings } from "../../worker/settings.ts";
import { wranglerCommand } from "./cloudflare.ts";
import { CLOUDFLARE_ENV, LOG_TAIL_LINES } from "./constants.ts";

/** The achq Worker's source in this checkout, which the CLI deploys the router and deployer from. */
export const WORKER_DIR = path.join(import.meta.dir, "../../worker");

/** A hash of the Worker's source, so a change to it redeploys. */
export const workerSourceHash = () =>
  crypto.sha256Hex(
    fs
      .readdirSync(WORKER_DIR)
      .filter((f) => f.endsWith(".ts"))
      .sort()
      .map((f) => `${f}\n${fs.readFileSync(path.join(WORKER_DIR, f), "utf8")}`)
      .join("\n"),
  );

export type WorkerConfigOptions = {
  /** Its entry module, relative to the config. */
  main: string;
  bucket: string;
  /** Images to build, by name: a Dockerfile, relative to the config. */
  images?: Record<string, { dockerfile: string; build_context: string }>;
  /** Public keys `wrangler containers ssh` connects with. */
  sshKeys?: string[];
};

/** A Worker's Wrangler config: the achq Worker, its container, its archive bucket, and what it is. */
export const workerConfig = (settings: WorkerSettings, { main, bucket, images, sshKeys = [] }: WorkerConfigOptions) => ({
  name: settings.name,
  main,
  compatibility_date: COMPATIBILITY.date,
  compatibility_flags: COMPATIBILITY.flags,
  workers_dev: true,
  // Its logs and its container's, kept so a slow or failed start can be looked into after the fact.
  observability: { enabled: true },
  // Which version it is, so its Durable Object can tell a newer one has been deployed.
  version_metadata: { binding: VERSION_BINDING },
  vars: { ACHQ_SERVICE: settings },
  r2_buckets: [{ binding: "ARCHIVE", bucket_name: bucket }],
  containers: [
    {
      class_name: SERVICE_CLASS,
      name: settings.name,
      // The Durable Object starts, snapshots and stops it.
      scheduling_policy: "durable_object",
      ...(images && { images }),
      // Without its comment, which Cloudflare refuses if it has spaces: only the key's type and the key.
      ...(sshKeys.length && { authorized_keys: sshKeys.map((key, i) => ({ name: `achq-${i + 1}`, public_key: key.trim().split(/\s+/).slice(0, 2).join(" ") })) }),
    },
  ],
  exports: { [SERVICE_CLASS]: { type: "durable-object", storage: "sqlite" } },
});

export type WorkerConfig = ReturnType<typeof workerConfig>;

/** Gzipped and base64'd, as a Builds variable takes it: each is at most 5 KB. */
export const packed = (value: string) => gzipSync(value, { level: 9 }).toString("base64");

/**
 * Deploys `config` with Wrangler to `accountId`, its secrets with it, from a
 * directory of its own: with CLOUDFLARE_API_TOKEN if `env` has one, or else
 * as Wrangler's signed in. `main` is taken as absolute. Throws with the end of
 * Wrangler's output.
 */
export const wranglerDeploy = async (env: Vars, accountId: string, config: WorkerConfig, secrets: Record<string, string>) => {
  const token = new Env(env).optional(CLOUDFLARE_ENV.token);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "achq-wrangler-"));
  try {
    const configFile = path.join(dir, "wrangler.json");
    const secretsFile = path.join(dir, "secrets.json");
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    fs.writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
    const wranglerEnv: Vars = { ...process.env, [CLOUDFLARE_ENV.accountId]: accountId };
    if (token) wranglerEnv[CLOUDFLARE_ENV.token] = token;
    else delete wranglerEnv[CLOUDFLARE_ENV.token];
    const { ok, stdout, stderr } = await subprocess.collect([...wranglerCommand(env), "deploy", "--config", configFile, "--secrets-file", secretsFile], { cwd: dir, env: wranglerEnv });
    if (!ok) throw new Error(`Wrangler couldn't deploy ${config.name}:\n${text.tailLines(`${stdout}\n${stderr}`, LOG_TAIL_LINES).join("\n")}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
