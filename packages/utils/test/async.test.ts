import { describe, expect, test } from "bun:test";
import { async } from "../src/async.ts";

describe("keyedQueue", () => {
  test("runs one key's work in order and other keys alongside", async () => {
    const queue = async.keyedQueue();
    const order: string[] = [];
    const task = (key: string, name: string, ms: number) => queue(key, async () => {
      order.push(`${name} in`);
      await Bun.sleep(ms);
      order.push(`${name} out`);
    });
    await Promise.all([task("x", "a", 30), task("x", "b", 0), task("y", "c", 0)]);
    expect(order).toEqual(["a in", "c in", "c out", "a out", "b in", "b out"]);
  });

  test("a failure doesn't stop what's queued after it", async () => {
    const queue = async.keyedQueue();
    const failed = queue("k", async () => {
      throw new Error("boom");
    });
    const next = queue("k", async () => "ran");
    await expect(failed).rejects.toThrow("boom");
    expect(await next).toBe("ran");
  });
});

test("serial runs one at a time", async () => {
  const lock = async.serial();
  let running = 0;
  let most = 0;
  const task = () => lock(async () => {
    most = Math.max(most, ++running);
    await Bun.sleep(5);
    running--;
  });
  await Promise.all([task(), task(), task()]);
  expect(most).toBe(1);
});

test("singleFlight shares a call in flight, then calls again", async () => {
  let calls = 0;
  const get = async.singleFlight(async () => {
    await Bun.sleep(5);
    return ++calls;
  });
  expect(await Promise.all([get(), get()])).toEqual([1, 1]);
  expect(await get()).toBe(2);
});

test("memo caches per key and forgets rejections", async () => {
  let calls = 0;
  const load = async.memo(async (key: string) => {
    calls++;
    if (key === "bad" && calls < 3) throw new Error("not yet");
    return key.toUpperCase();
  });
  expect(await load("a")).toBe("A");
  expect(await load("a")).toBe("A");
  expect(calls).toBe(1);
  await expect(load("bad")).rejects.toThrow("not yet");
  expect(await load("bad")).toBe("BAD");
});

test("every calls until disposed", async () => {
  let ticks = 0;
  const stop = async.every(5, () => ticks++);
  await Bun.sleep(30);
  stop();
  const seen = ticks;
  await Bun.sleep(20);
  expect(seen).toBeGreaterThan(0);
  expect(ticks).toBe(seen);
});

describe("pollUntil", () => {
  test("probes until done, sleeping between", async () => {
    const values = [1, 2, 3];
    const slept: number[] = [];
    const found = await async.pollUntil(async () => values.shift()!, (v) => v === 3, { intervalMs: 10, timeoutMs: 1000, sleep: async (ms) => void slept.push(ms) });
    expect(found).toBe(3);
    expect(slept).toEqual([10, 10]);
  });

  test("gives up once it has slept the timeout", async () => {
    let probes = 0;
    let clock = 0;
    const found = await async.pollUntil(async () => ++probes, () => false, { intervalMs: 5000, timeoutMs: 15_000, sleep: async (ms) => void (clock += ms) });
    expect(found).toBeUndefined();
    expect(clock).toBe(15_000);
    expect(probes).toBe(4);
  });
});

describe("pollOrThrow", () => {
  const noSleep = async () => {};

  test("answers the value done accepts, even an undefined one", async () => {
    const values = [1, undefined];
    const found = await async.pollOrThrow(async () => values.shift(), (v) => v === undefined, { intervalMs: 10, timeoutMs: 1000, sleep: noSleep, timedOut: () => "never" });
    expect(found).toBeUndefined();
    expect(values).toEqual([]);
  });

  test("throws timedOut of how long it polled, in minutes", async () => {
    const options = { intervalMs: 60_000, sleep: noSleep, timedOut: (after: string) => `not done after ${after}` };
    await expect(async.pollOrThrow(async () => 0, () => false, { ...options, timeoutMs: 5 * 60_000 })).rejects.toThrow("not done after 5 minutes");
    await expect(async.pollOrThrow(async () => 0, () => false, { ...options, timeoutMs: 60_000 })).rejects.toThrow("not done after 1 minute");
  });
});

describe("retry", () => {
  test("tries once, then after each delay, until one succeeds", async () => {
    const slept: number[] = [];
    let n = 0;
    const result = await async.retry(async () => (++n < 3 ? { ok: false, error: `try ${n}` } : { ok: true, value: n }), [10, 20, 30], async (ms) => void slept.push(ms));
    expect(result).toEqual({ ok: true, value: 3 });
    expect(slept).toEqual([10, 20]);
  });

  test("gives up with the last error, counting throws as failures", async () => {
    let n = 0;
    const result = await async.retry(
      async () => {
        if (++n === 2) throw new Error("thrown");
        return { ok: false, error: `try ${n}` };
      },
      [1],
      async () => {},
    );
    expect(result).toEqual({ ok: false, error: "thrown", attempts: 2 });
  });
});

test("allOf awaits a record's promises together, keeping their keys", async () => {
  expect(await async.allOf({ a: Promise.resolve(1), b: Promise.resolve("two"), c: undefined })).toEqual({ a: 1, b: "two", c: undefined });
  await expect(async.allOf({ a: Promise.reject(new Error("no")) })).rejects.toThrow("no");
});
