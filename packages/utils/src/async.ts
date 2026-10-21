import { errors } from "./errors.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type PollOptions = {
  intervalMs: number;
  /** How long to keep trying, counted as the time slept between probes, so a fake `sleep` makes it exact. */
  timeoutMs: number;
  sleep?: (ms: number) => Promise<void>;
};

export type Attempt<T> = { ok: true; value: T } | { ok: false; error: string };

export type Retried<T> = { ok: true; value: T } | { ok: false; error: string; attempts: number };

export const async = {
  /**
   * Runs work for the same key one at a time, in the order it was asked for. A
   * failure doesn't stop the work queued after it. Idle keys are forgotten.
   */
  keyedQueue: () => {
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
  },

  /** A failure doesn't stop the work queued after it. */
  serial: () => {
    const queue = async.keyedQueue();
    return <T>(work: () => Promise<T>): Promise<T> => queue("", work);
  },

  /** `fn`, sharing one call among everyone who asks while it's in flight. The next ask after it settles calls again. */
  singleFlight: <T>(fn: () => Promise<T>): (() => Promise<T>) => {
    let inFlight: Promise<T> | undefined;
    return () =>
      (inFlight ??= fn().finally(() => {
        inFlight = undefined;
      }));
  },

  /** A rejection is forgotten, so the next ask tries again. */
  memo: <K, V>(fn: (key: K) => Promise<V>): ((key: K) => Promise<V>) => {
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
  },

  /** `Promise.all` over a record: the same keys, each with its promise's value, so reads made together keep their names. */
  allOf: async <T extends Record<string, unknown>>(promises: T): Promise<{ [K in keyof T]: Awaited<T[K]> }> => {
    const keys = Object.keys(promises);
    const values = await Promise.all(Object.values(promises));
    return Object.fromEntries(keys.map((key, i) => [key, values[i]])) as { [K in keyof T]: Awaited<T[K]> };
  },

  /** Calls `fn` every `ms` until the returned function is called. */
  every: (ms: number, fn: () => void): (() => void) => {
    const timer = setInterval(fn, ms);
    return () => clearInterval(timer);
  },

  /** Undefined once `timeoutMs` has been slept without success. A throw from `probe` stops polling. */
  pollUntil: async <T>(probe: () => Promise<T>, done: (value: T) => boolean, options: PollOptions) => {
    const { intervalMs, timeoutMs, sleep: wait = sleep } = options;
    for (let slept = 0; ; slept += intervalMs) {
      const value = await probe();
      if (done(value)) return value;
      if (slept >= timeoutMs) return undefined;
      await wait(intervalMs);
    }
  },

  /**
   * Attempts at once, then again after each of `delays`, until one succeeds. A
   * throw counts as a failed attempt. On giving up, the last failure's error.
   */
  retry: async <T>(attempt: () => Promise<Attempt<T>>, delays: readonly number[], wait = sleep): Promise<Retried<T>> => {
    let last = "";
    for (const delay of [0, ...delays]) {
      if (delay) await wait(delay);
      const outcome = await attempt().catch((e): Attempt<T> => ({ ok: false, error: errors.message(e) }));
      if (outcome.ok) return outcome;
      last = outcome.error;
    }
    return { ok: false, error: last, attempts: delays.length + 1 };
  },
};
