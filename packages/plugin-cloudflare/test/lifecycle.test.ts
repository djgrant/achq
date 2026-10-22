import { expect, test } from "bun:test";
import { type Box, envFile, IDLE_MS, Lifecycle, type Memory, SNAPSHOT_EVERY_MS, type StartOptions, TICK_MS } from "../worker/lifecycle.ts";
import { APP_IMAGE, MANAGED_IMAGE, type WorkerSettings } from "../worker/settings.ts";

/** A container as its Durable Object sees it: what it was started from, what it ran, its snapshots and its archive. */
const fakeBox = (images: Record<string, string> = { app: "img-1" }) => {
  let n = 0;
  const box = {
    running: false,
    images,
    starts: [] as StartOptions[],
    /** Every command run in it, by script's first distinctive word. */
    execs: [] as string[],
    snapshots: [] as { id: string; of: StartOptions; data: string }[],
    destroyed: 0,
    /** The archive in R2: what /data was when last archived. */
    archive: undefined as string | undefined,
    /** What /data has in the running container. */
    data: "",
    /** Snapshots that won't start. */
    broken: new Set<string>(),
    start(options: StartOptions) {
      if (box.running) throw new Error("already running");
      box.starts.push(options);
      if ("containerSnapshot" in options) {
        if (box.broken.has(options.containerSnapshot.id)) return;
        box.data = box.snapshots.find((s) => s.id === options.containerSnapshot.id)!.data;
      } else box.data = "";
      box.running = true;
    },
    intercept: async () => {},
    setInactivityTimeout: async () => {},
    snapshot: async () => {
      const id = `snap-${++n}`;
      box.snapshots.push({ id, of: box.starts.at(-1)!, data: box.data });
      return { id };
    },
    destroy: async () => {
      box.running = false;
      box.destroyed++;
    },
    exec: async (command: string[]) => {
      const script = command.join(" ");
      if (script.includes("tar -czpf")) {
        box.execs.push("archive");
        box.archive = box.data;
      } else if (script.includes("tar -xzpf")) {
        box.execs.push("restore");
        box.data = box.archive ?? "";
      } else box.execs.push("env-file");
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    answers: async () => box.running,
  };
  return box;
};

const fakeMemory = () => {
  const values = new Map<string, unknown>();
  const memory: Memory & { values: Map<string, unknown> } = {
    values,
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key, value) => void values.set(key, value),
    delete: async (key) => void values.delete(key),
  };
  return memory;
};

const containerSettings: WorkerSettings = { name: "c", port: 3000, sleeps: true, restartOnChange: false, image: APP_IMAGE, instance: "standard-1", workersDev: "acme.workers.dev" };

const setup = (settings = containerSettings, box = fakeBox(), memory = fakeMemory(), config = "config-1") => {
  let now = 1_800_000_000_000;
  const lifecycle = new Lifecycle({ settings, env: { A: "1" }, config, box: box as unknown as Box, memory, now: () => now, sleep: async () => {}, log: () => {} });
  return { lifecycle, box, memory, advance: (ms: number) => (now += ms), now: () => now };
};

const forward = async () => new Response("ok");

test("a request starts the container from its image, then from the snapshot taken when it went idle", async () => {
  const { lifecycle, box, advance } = setup();
  expect(await (await lifecycle.serve(3000, forward)).text()).toBe("ok");
  expect(box.starts).toEqual([{ image: "img-1", env: { A: "1" }, instance: "standard-1" }]);
  expect(box.execs).toEqual(["env-file"]);
  box.data = "work";

  // Busy within the idle window: it keeps running, and is archived once a day.
  advance(TICK_MS);
  expect(await lifecycle.tick()).toBeDefined();
  expect(box.execs).toEqual(["env-file", "archive"]);
  expect(box.running).toBe(true);

  advance(IDLE_MS);
  expect(await lifecycle.tick()).toBeUndefined();
  expect(box.running).toBe(false);
  expect(box.snapshots.map((s) => s.id)).toEqual(["snap-1"]);

  await lifecycle.serve(3000, forward);
  expect(box.starts.at(-1)).toEqual({ containerSnapshot: { id: "snap-1" }, env: { A: "1" }, instance: "standard-1" });
  expect(box.data).toBe("work");
});

test("a request in flight keeps it awake, and a long run is snapshotted every half hour", async () => {
  const { lifecycle, box, advance } = setup();
  let finish!: () => void;
  const held = lifecycle.serve(3000, () => new Promise<Response>((resolve) => (finish = () => resolve(new Response("done")))));
  while (!finish) await Bun.sleep(1);
  advance(IDLE_MS + 1);
  await lifecycle.tick();
  expect(box.running).toBe(true);
  advance(SNAPSHOT_EVERY_MS);
  await lifecycle.tick();
  expect(box.running).toBe(true);
  expect(box.snapshots).toHaveLength(1);
  finish();
  await held;
});

test("a snapshot of an older image is moved onto the new one through the archive", async () => {
  const { lifecycle, box, memory, advance } = setup();
  await lifecycle.serve(3000, forward);
  box.data = "work";
  await lifecycle.park();
  // A rebuild changes the image its Worker starts.
  box.images.app = "img-2";
  advance(TICK_MS);
  await lifecycle.serve(3000, forward);
  expect(box.starts.map((s) => ("image" in s ? s.image : s.containerSnapshot.id))).toEqual(["img-1", "snap-1", "img-2", "snap-2"]);
  // The old snapshot ran nothing but the archive; the new image ran nothing but the restore.
  expect(box.starts[1]!.entrypoint).toEqual(["sleep", "infinity"]);
  expect(box.starts[2]!.entrypoint).toEqual(["sleep", "infinity"]);
  expect(box.execs.slice(1)).toEqual(["archive", "restore", "env-file"]);
  expect(box.data).toBe("work");
  expect(memory.values.get("snapshot")).toMatchObject({ id: "snap-2", image: "img-2" });
});

test("a snapshot that won't start is recovered from the archive", async () => {
  const { lifecycle, box, advance } = setup();
  await lifecycle.serve(3000, forward);
  box.data = "archived";
  advance(TICK_MS);
  await lifecycle.tick(); // archives
  box.data = "later";
  await lifecycle.park();
  box.broken.add("snap-1");
  await lifecycle.serve(3000, forward);
  expect(box.data).toBe("archived");
  expect(box.running).toBe(true);
});

test("a service restarts with its Worker's new config, and one that doesn't sleep is started by its alarm", async () => {
  const settings: WorkerSettings = { ...containerSettings, sleeps: false, restartOnChange: true, image: MANAGED_IMAGE, entrypoint: ["sh", "-c", "run"] };
  const memory = fakeMemory();
  const box = fakeBox();
  const first = setup(settings, box, memory, "config-1");
  await first.lifecycle.serve(8080, forward);
  expect(box.starts[0]).toMatchObject({ image: MANAGED_IMAGE, entrypoint: ["sh", "-c", "run"] });

  // A new Worker version, with other variables: the next look restarts it from a snapshot.
  const second = setup(settings, box, memory, "config-2");
  await second.lifecycle.tick();
  expect(box.starts.at(-1)).toMatchObject({ containerSnapshot: { id: "snap-1" } });

  await box.destroy();
  expect(await second.lifecycle.tick()).toBeDefined();
  expect(box.running).toBe(true);
});

test("a container's environment is written for shells as exports, quoted", () => {
  expect(envFile({ A: "it's", B: "x y" })).toBe(`export A='it'\\''s'\nexport B='x y'\n`);
});
