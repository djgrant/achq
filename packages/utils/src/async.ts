import { errorMessage } from "./errors.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs work for the same key one at a time, in the order it was asked for. A
 * failure doesn't stop the work queued after it. Idle keys are forgotten.
 */
export const keyedQueue = () => {
  const chains = new Map<string, Promise<unknown>>();
  return <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const next = (chains.get(key) ?? Promise.resolve()).then(work, work);
    chains.set(key, next);
    const forgetIfIdle = () => {
      if (chains.get(key) === next) chains.delete(key);
    };
    next.then(forgetIfIdle, forgetIfIdle);
    return next;
  };
};

/** A failure doesn't stop the work queued after it. */
export const serial = () => {
  const queue = keyedQueue();
  return <T>(work: () => Promise<T>): Promise<T> => queue("", work);
};

/** `fn`, sharing one call among everyone who asks while it's in flight. The next ask after it settles calls again. */
export const singleFlight = <T>(fn: () => Promise<T>): (() => Promise<T>) => {
  let inFlight: Promise<T> | undefined;
  return () =>
    (inFlight ??= fn().finally(() => {
      inFlight = undefined;
    }));
};

/** A rejection is forgotten, so the next ask tries again. */
export const memoAsync = <K, V>(fn: (key: K) => Promise<V>): ((key: K) => Promise<V>) => {
  const cache = new Map<K, Promise<V>>();
  return (key) => {
    let value = cache.get(key);
    if (!value) {
      value = fn(key);
      cache.set(key, value);
      value.catch(() => cache.delete(key));
    }
    return value;
  };
};

/** A throw isn't cached. */
export const memo = <K, V>(fn: (key: K) => V): ((key: K) => V) => {
  const cache = new Map<K, V>();
  return (key) => {
    if (!cache.has(key)) cache.set(key, fn(key));
    return cache.get(key)!;
  };
};

/** `Promise.all` over a record: the same keys, each with its promise's value, so reads made together keep their names. */
export const allOf = async <T extends Record<string, unknown>>(promises: T): Promise<{ [K in keyof T]: Awaited<T[K]> }> => {
  const keys = Object.keys(promises);
  const values = await Promise.all(Object.values(promises));
  return Object.fromEntries(keys.map((key, i) => [key, values[i]])) as { [K in keyof T]: Awaited<T[K]> };
};

export const every = (ms: number, fn: () => void): (() => void) => {
  const timer = setInterval(fn, ms);
  return () => clearInterval(timer);
};

export type PollOptions = {
  intervalMs: number;
  /** How long to keep trying, counted as the time slept between probes, so a fake `sleep` makes it exact. */
  timeoutMs: number;
  sleep?: (ms: number) => Promise<void>;
};

/** Undefined once `timeoutMs` has been slept without success. A throw from `probe` stops polling. */
export const pollUntil = async <T>(probe: () => Promise<T>, done: (value: T) => boolean, options: PollOptions): Promise<T | undefined> => {
  const { intervalMs, timeoutMs, sleep: wait = sleep } = options;
  for (let slept = 0; ; slept += intervalMs) {
    const value = await probe();
    if (done(value)) return value;
    if (slept >= timeoutMs) return undefined;
    await wait(intervalMs);
  }
};

export type Attempt<T> = { ok: true; value: T } | { ok: false; error: string };

export type Retried<T> = { ok: true; value: T } | { ok: false; error: string; attempts: number };

/**
 * Attempts at once, then again after each of `delays`, until one succeeds. A
 * throw counts as a failed attempt. On giving up, the last failure's error.
 */
export const retry = async <T>(attempt: () => Promise<Attempt<T>>, delays: readonly number[], wait = sleep): Promise<Retried<T>> => {
  let last = "";
  for (const delay of [0, ...delays]) {
    if (delay) await wait(delay);
    const outcome = await attempt().catch((e): Attempt<T> => ({ ok: false, error: errorMessage(e) }));
    if (outcome.ok) return outcome;
    last = outcome.error;
  }
  return { ok: false, error: last, attempts: delays.length + 1 };
};
