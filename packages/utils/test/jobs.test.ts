import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { Job, jobs, type JobsOptions } from "../src/jobs.ts";
import { allOf, type JsonStore } from "../src/store/json-store.ts";
import { collection } from "../src/store/index.ts";

/** A store in memory, as it was written. */
const memoryStore = () => {
  const values = new Map<string, unknown>();
  const store: JsonStore = {
    read: async (name) => structuredClone(values.get(name)),
    write: async (name, value) => void values.set(name, structuredClone(value)),
    remove: async (name) => void values.delete(name),
    list: async () => [...values.keys()].sort(),
    all: () => allOf(store),
  };
  return { values, store };
};

const Result = v.looseObject({ n: v.number() });

/** Jobs over a fresh store, on a clock that moves only when `tick` says. */
const setup = async (options: Partial<JobsOptions> = {}) => {
  const { values, store } = memoryStore();
  let clock = Date.UTC(2026, 9, 25, 10, 0, 0);
  const logs: string[] = [];
  const open = async () =>
    jobs(await collection(() => store, "jobs", Job(Result), { log: (line) => logs.push(line) }), {
      keep: 3,
      heartbeatMs: 1_000,
      now: () => new Date(clock),
      log: (line) => logs.push(line),
      ...options,
    });
  return { values, logs, open, tick: (ms: number) => void (clock += ms) };
};

/** A promise and what settles it, for work a test finishes when it chooses. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Lets the work's outcome be written. */
const settle = () => Bun.sleep(1);

describe("jobs", () => {
  test("a job is running until its work gives a result, then done with it", async () => {
    const { open, values } = await setup();
    const syncs = await open();
    const work = deferred<{ n: number }>();
    const id = await syncs.start(() => work.promise);
    expect(values.get(id)).toMatchObject({ id, state: "running" });
    expect(await syncs.status(id)).toEqual({ state: "running" });
    work.resolve({ n: 1 });
    await settle();
    expect(await syncs.status(id)).toEqual({ state: "done", result: { n: 1 } });
  });

  test("work that throws fails, with its message, and is logged", async () => {
    const { open, logs } = await setup();
    const syncs = await open();
    const id = await syncs.start(async () => {
      throw new Error("no luck");
    });
    await settle();
    expect(await syncs.status(id)).toEqual({ state: "failed", error: "no luck" });
    expect(logs.some((l) => l.startsWith(`job ${id}: Error: no luck`))).toBe(true);
  });

  test("an unknown job has no status", async () => {
    const { open } = await setup();
    expect(await (await open()).status("nope")).toBeUndefined();
  });

  test("starting one keeps only the newest `keep`, running or not", async () => {
    const { open, values, tick } = await setup();
    const syncs = await open();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await syncs.start(async () => ({ n: i })));
      tick(10);
    }
    await settle();
    expect([...values.keys()].sort()).toEqual(ids.slice(2).sort());
    expect(await syncs.status(ids[0]!)).toBeUndefined();
    expect(await syncs.status(ids[4]!)).toEqual({ state: "done", result: { n: 4 } });
  });

  test("a job removed while it runs is aborted, and how it went isn't written", async () => {
    const { open, values, tick } = await setup({ keep: 1, heartbeatMs: 5 });
    const syncs = await open();
    const work = deferred<{ n: number }>();
    let signal: AbortSignal | undefined;
    const first = await syncs.start((s) => {
      signal = s;
      return work.promise;
    });
    tick(10);
    await syncs.start(async () => ({ n: 2 }));
    await Bun.sleep(20);
    expect(signal?.aborted).toBe(true);
    work.resolve({ n: 1 });
    await settle();
    expect(values.has(first)).toBe(false);
  });

  test("a running job whose heartbeat is stale reads as interrupted, as one whose process stopped does", async () => {
    const { open, tick } = await setup();
    const before = await open();
    // Never settles, and the heartbeat's beat is far off: as if its process had stopped.
    const id = await before.start(() => new Promise(() => {}));
    tick(3_000);
    expect(await before.status(id)).toEqual({ state: "running" });
    tick(1);
    // A process opening the same store reads it the same, with nothing marked at startup.
    const after = await open();
    expect(await after.status(id)).toEqual({ state: "interrupted" });
    expect(await before.status(id)).toEqual({ state: "interrupted" });
  });

  test("a running job's heartbeat is refreshed, so it stays running, and stops once it's done", async () => {
    const { open, values, tick } = await setup({ heartbeatMs: 5 });
    const syncs = await open();
    const work = deferred<{ n: number }>();
    const id = await syncs.start(() => work.promise);
    const started = (values.get(id) as { heartbeat: string }).heartbeat;
    tick(100);
    await Bun.sleep(20);
    const beat = (values.get(id) as { heartbeat: string }).heartbeat;
    expect(beat).not.toBe(started);
    expect(await syncs.status(id)).toEqual({ state: "running" });

    work.resolve({ n: 1 });
    await settle();
    const done = structuredClone(values.get(id));
    tick(100);
    await Bun.sleep(20);
    expect(values.get(id)).toEqual(done);
    expect(done).toMatchObject({ state: "done", started: new Date(Date.UTC(2026, 9, 25, 10, 0, 0)).toISOString() });
  });

  test("a stored job that isn't readable has no status", async () => {
    const { open, values } = await setup();
    values.set("odd", { id: "odd", state: "done", started: "x", heartbeat: "x" });
    expect(await (await open()).status("odd")).toBeUndefined();
  });
});
