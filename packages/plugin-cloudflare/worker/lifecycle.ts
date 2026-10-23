// How an achq Worker's Durable Object keeps its container: when it starts, from
// what, when it's snapshotted, and when it sleeps. A container's disk only
// outlives a stop in a snapshot, and Cloudflare only snapshots when asked, so
// every stop that keeps anything is this one's: snapshot, then stop. Written
// against `Box` and `Memory` rather than Cloudflare's own objects, so it runs
// in tests too.

import { DATA_DIR, INTERNAL_HOSTS, MANAGED_IMAGE, type WorkerSettings } from "./settings.ts";

const MINUTE_MS = 60_000;
/** How often the Durable Object looks at its container while it runs. */
export const TICK_MS = MINUTE_MS;
/** A sleeping service sleeps after this long with no request and no keep-awake fetch. */
export const IDLE_MS = 10 * MINUTE_MS;
/** How often a long run is snapshotted, which is what a crash loses at most. */
export const SNAPSHOT_EVERY_MS = 30 * MINUTE_MS;
/** How often /data is archived to R2, in case a snapshot is lost: they expire 30 days after their last restore. */
export const ARCHIVE_EVERY_MS = 24 * 60 * MINUTE_MS;
/** How long Cloudflare keeps a container once its Durable Object goes quiet: the ticks keep it busy, so this only matters if they stop. */
export const INACTIVITY_MS = 30 * MINUTE_MS;
/** How long a request waits for the container to answer on its port before it's told to try again. */
export const READY_TIMEOUT_MS = 25_000;
const READY_POLL_MS = 250;

/** Runs a container with nothing but a shell, for archiving and restoring /data. */
const IDLE_ENTRYPOINT = ["sleep", "infinity"];

/** Where the container's environment is written, for shells: `wrangler containers ssh` doesn't pass it on. */
export const ENV_FILE = "/run/achq/env";

/** Uploads /data as a gzipped tar to the container's archive, with curl or else Node: empty, if it never ran. */
const ARCHIVE_SCRIPT = [
  "set -e",
  "f=/tmp/achq-data.tar.gz",
  `mkdir -p ${DATA_DIR}`,
  `tar -czpf "$f" --numeric-owner -C / ${DATA_DIR.slice(1)}`,
  `if command -v curl >/dev/null; then curl -fsS -T "$f" "http://${INTERNAL_HOSTS.archive}/"`,
  `else F="$f" node -e 'fetch("http://${INTERNAL_HOSTS.archive}/", { method: "PUT", body: require("fs").readFileSync(process.env.F) }).then((r) => process.exit(r.ok ? 0 : 1))'; fi`,
  'rm -f "$f"',
].join("\n");

/** Unpacks the archive over /data. */
const RESTORE_SCRIPT = [
  "set -e",
  "f=/tmp/achq-data.tar.gz",
  `if command -v curl >/dev/null; then curl -fsS -o "$f" "http://${INTERNAL_HOSTS.archive}/"`,
  `else F="$f" node -e 'fetch("http://${INTERNAL_HOSTS.archive}/").then(async (r) => { if (!r.ok) process.exit(1); require("fs").writeFileSync(process.env.F, Buffer.from(await r.arrayBuffer())); })'; fi`,
  `tar -xzpf "$f" -C / --numeric-owner --same-owner`,
  'rm -f "$f"',
].join("\n");

/** Writes the environment to ENV_FILE, readable by root alone, from the variable it's passed in. */
const ENV_FILE_SCRIPT = `mkdir -p ${ENV_FILE.slice(0, ENV_FILE.lastIndexOf("/"))} && umask 077 && printf '%s' "$ACHQ_ENV_FILE" > ${ENV_FILE}`;

export type StartFrom = { image: string } | { containerSnapshot: { id: string } };

export type StartOptions = StartFrom & { env?: Record<string, string>; entrypoint?: string[]; instance: string };

/** What the Durable Object's container gives the lifecycle. */
export interface Box {
  readonly running: boolean;
  /** The images its Worker's config names, digest-pinned. */
  readonly images: Record<string, string>;
  start(options: StartOptions): void;
  /** Routes its outbound HTTP to INTERNAL_DOMAIN through the Worker. */
  intercept(): Promise<void>;
  setInactivityTimeout(ms: number): Promise<void>;
  snapshot(name: string): Promise<{ id: string }>;
  destroy(): Promise<void>;
  exec(command: string[], env?: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Whether something answers HTTP on `port`. */
  answers(port: number): Promise<boolean>;
}

/** The Durable Object's storage. */
export interface Memory {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** A snapshot, and the image it can only be restored onto. */
export type Saved = { id: string; image: string; at: number };

const KEYS = {
  snapshot: "snapshot",
  /** When /data was last archived to R2. */
  archived: "archived",
  /** What the running container was started with: a change restarts a service. */
  startedWith: "startedWith",
  /** The image the running container runs, which its snapshots can only be restored onto. */
  running: "running",
  /** When the running container started. */
  started: "started",
  lastActivity: "lastActivity",
} as const;

export type LifecycleDeps = {
  settings: WorkerSettings;
  /** Its variables. */
  env: Record<string, string>;
  /** Variables it starts with that its shells don't get, e.g. the deployer's token. */
  secrets?: Record<string, string>;
  /** A hash of `settings`, `env` and `secrets`. */
  config: string;
  box: Box;
  memory: Memory;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** The environment as a shell script that exports it. */
export const envFile = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([name, value]) => `export ${name}=${quote(value)}\n`)
    .join("");

export class Lifecycle {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  /** Requests being answered: a service with any isn't idle. */
  private inFlight = 0;
  /** As stored, so it's written at most once a minute. */
  private lastActivity?: number;
  /** One start at a time, shared by whoever asks while it's going. */
  private starting?: Promise<void>;

  constructor(private readonly deps: LifecycleDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /** The image a fresh start uses now: its Worker's current one. */
  private get image() {
    const { settings, box } = this.deps;
    if (settings.image === MANAGED_IMAGE) return MANAGED_IMAGE;
    const image = box.images[settings.image];
    if (!image) throw new Error(`${settings.name} has no ${settings.image} image yet; it's built by its first deploy`);
    return image;
  }

  // ── Requests ──

  /** Answers a request with the container, starting it if it has to, and counts it as activity. */
  async serve(port: number, forward: () => Promise<Response>) {
    this.inFlight++;
    try {
      await this.touch();
      await this.ensureRunning();
      if (!(await this.waitUntilAnswering(port))) return new Response(`${this.deps.settings.name} is starting`, { status: 503, headers: { "retry-after": "5" } });
      return await forward();
    } finally {
      this.inFlight--;
      await this.touch();
    }
  }

  /** Activity, e.g. a keep-awake fetch. */
  async touch() {
    const now = this.now();
    if (this.lastActivity !== undefined && now - this.lastActivity < MINUTE_MS) return;
    this.lastActivity = now;
    await this.deps.memory.put(KEYS.lastActivity, now);
  }

  private async waitUntilAnswering(port: number) {
    for (let waited = 0; waited <= READY_TIMEOUT_MS; waited += READY_POLL_MS) {
      if (await this.deps.box.answers(port)) return true;
      if (!this.deps.box.running) return false;
      await this.sleep(READY_POLL_MS);
    }
    return false;
  }

  // ── Starting ──

  /** Starts the container unless it's running. A service running with config its Worker has since changed is restarted. */
  ensureRunning() {
    return (this.starting ??= this.startIfNeeded().finally(() => (this.starting = undefined)));
  }

  private async startIfNeeded() {
    const { box, memory, settings, config } = this.deps;
    if (box.running) {
      if (!settings.restartOnChange || (await memory.get(KEYS.startedWith)) === config) return;
      this.log(`${settings.name}: its config changed; restarting`);
      await this.park();
    }
    await this.start();
  }

  /**
   * From its snapshot when it was taken of the current image. One of an older
   * image is moved onto the new one through the archive; with none, or one
   * that won't start, the archive is restored onto a fresh one, if there is one.
   */
  private async start() {
    const { memory, settings } = this.deps;
    const image = this.image;
    const saved = await memory.get<Saved>(KEYS.snapshot);
    if (saved && saved.image === image) {
      if (await this.boot({ containerSnapshot: { id: saved.id } }, image)) return;
      this.log(`${settings.name}: snapshot ${saved.id} didn't start; recovering from the archive`);
      await memory.delete(KEYS.snapshot);
      await this.recover(image);
    } else if (saved) {
      this.log(`${settings.name}: moving /data from its last image onto the new one`);
      await this.archiveFrom({ containerSnapshot: { id: saved.id } });
      await this.recover(image);
    } else if (await memory.get(KEYS.archived)) {
      await this.recover(image);
    } else {
      await this.boot({ image }, image);
    }
  }

  /** Restores the archive onto a fresh `image`, snapshots that, and starts from it. */
  private async recover(image: string) {
    if (!(await this.deps.memory.get(KEYS.archived))) return void (await this.boot({ image }, image));
    let restored!: Saved;
    await this.idle({ image }, async () => {
      await this.run(RESTORE_SCRIPT, "restoring /data from the archive");
      restored = await this.save(image);
    });
    if (!(await this.boot({ containerSnapshot: { id: restored.id } }, image))) throw new Error(`${this.deps.settings.name} didn't start from its restored snapshot`);
  }

  /** Archives /data from a container started from `from`, without running its command. */
  private async archiveFrom(from: StartFrom) {
    await this.idle(from, () => this.archive());
  }

  /** Runs `work` in a container started from `from` that runs nothing, then stops it. */
  private async idle(from: StartFrom, work: () => Promise<void>) {
    const { box, settings } = this.deps;
    box.start({ ...from, entrypoint: IDLE_ENTRYPOINT, instance: settings.instance });
    try {
      await box.intercept();
      await work();
    } finally {
      await box.destroy();
    }
  }

  /** Starts it to run `image`, from it or a snapshot of it. False if it isn't running once started, as when its snapshot can't be restored. */
  private async boot(from: StartFrom, image: string) {
    const { box, memory, settings, env, secrets, config } = this.deps;
    box.start({ ...from, env: { ...env, ...secrets }, ...(settings.entrypoint && { entrypoint: settings.entrypoint }), instance: settings.instance });
    await box.intercept();
    await box.setInactivityTimeout(INACTIVITY_MS);
    if (!box.running) return false;
    // A shell's environment, for `achq container ssh`.
    const written = await box.exec(["sh", "-c", ENV_FILE_SCRIPT], { ACHQ_ENV_FILE: envFile(env) });
    if (written.exitCode !== 0) this.log(`${settings.name}: couldn't write ${ENV_FILE}: ${written.stderr.trim()}`);
    await memory.put(KEYS.startedWith, config);
    await memory.put(KEYS.running, image);
    await memory.put(KEYS.started, this.now());
    // Started counts as activity: a woken service gets its idle window before it sleeps again.
    this.lastActivity = undefined;
    await this.touch();
    return true;
  }

  // ── Keeping ──

  /** Snapshots it, recording the snapshot against `image`, the one it runs: by default, the one it was started with. */
  private async save(image?: string) {
    const snapshot = await this.deps.box.snapshot(this.deps.settings.name);
    const saved: Saved = { id: snapshot.id, image: image ?? (await this.deps.memory.get<string>(KEYS.running)) ?? this.image, at: this.now() };
    await this.deps.memory.put(KEYS.snapshot, saved);
    return saved;
  }

  private async archive() {
    await this.run(ARCHIVE_SCRIPT, "archiving /data");
    await this.deps.memory.put(KEYS.archived, this.now());
  }

  private async run(script: string, what: string) {
    const { exitCode, stderr } = await this.deps.box.exec(["sh", "-c", script]);
    if (exitCode !== 0) throw new Error(`${this.deps.settings.name}: ${what} failed: ${stderr.trim()}`);
  }

  /** Snapshots then stops it: what every stop that keeps /data is. */
  async park() {
    const { box } = this.deps;
    if (!box.running) return;
    await this.save();
    await box.destroy();
  }

  /**
   * What the Durable Object's alarm does: sleeps an idle service, snapshots a
   * long run, archives /data daily, and starts a service that doesn't sleep if
   * it has stopped. Returns when to look again, or undefined to stop looking.
   */
  async tick(): Promise<number | undefined> {
    const { box, memory, settings } = this.deps;
    const now = this.now();
    if (!box.running) {
      if (settings.sleeps) return undefined;
      await this.ensureRunning();
      return now + TICK_MS;
    }
    if (settings.restartOnChange) await this.ensureRunning();
    const lastActivity = (await memory.get<number>(KEYS.lastActivity)) ?? now;
    if (settings.sleeps && this.inFlight === 0 && now - lastActivity >= IDLE_MS) {
      this.log(`${settings.name}: idle; snapshotting and stopping`);
      await this.park();
      return undefined;
    }
    // What a crash would lose: everything since it started or was last snapshotted, whichever is later.
    const kept = Math.max((await memory.get<Saved>(KEYS.snapshot))?.at ?? 0, (await memory.get<number>(KEYS.started)) ?? now);
    if (now - kept >= SNAPSHOT_EVERY_MS) await this.save();
    if (now - ((await memory.get<number>(KEYS.archived)) ?? 0) >= ARCHIVE_EVERY_MS) await this.archive();
    return now + TICK_MS;
  }
}

