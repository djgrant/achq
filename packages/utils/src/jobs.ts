import * as v from "valibot";
import type { Reads } from "./schema.ts";
import { errors } from "./errors.ts";
import type { JsonStore } from "./store/json-store.ts";

/**
 * A job as it's stored: `running` until its work settles, then `done` with
 * its result or `failed` with its error. `heartbeat` is when the process
 * running it last said so. Loose, as another version may have written it.
 */
export type Job<R> = { id: string; started: string; heartbeat: string; [key: string]: unknown } & (
  | { state: "running" }
  | { state: "done"; result: R }
  | { state: "failed"; error: string }
);

/** A stored job, read against `result` for what a done one gave. */
export const Job = <R>(result: Reads<R>): Reads<Job<R>> => {
  const base = { id: v.string(), started: v.string(), heartbeat: v.string() };
  return v.variant("state", [
    v.looseObject({ ...base, state: v.literal("running") }),
    v.looseObject({ ...base, state: v.literal("done"), result }),
    v.looseObject({ ...base, state: v.literal("failed"), error: v.string() }),
  ]) as Reads<Job<R>>;
};

/** How a job is going: `interrupted` is a running one whose process has stopped saying so, as one that restarted has. */
export type JobStatus<R> = { state: "running" } | { state: "done"; result: R } | { state: "failed"; error: string } | { state: "interrupted" };

export type JobsOptions = {
  /** How many jobs are kept, the newest started: starting one removes the rest. */
  keep: number;
  /** How often a running job's heartbeat is written. One that's missed `STALE_BEATS` reads as interrupted. */
  heartbeatMs: number;
  now?: () => Date;
  /** Where a job's failure, and a heartbeat that couldn't be written, are reported. */
  log?: (line: string) => void;
};

/** How many heartbeats a running job may miss before it reads as interrupted: room for a slow write, and for clocks that differ a little between processes. */
export const STALE_BEATS = 3;

/**
 * Background work kept in `store`, so how it went outlives the process that
 * ran it. Nothing is marked when a process starts: a running job whose
 * heartbeat is stale reads as interrupted, which holds while an old process
 * and its replacement overlap, each running jobs of its own.
 */
export const jobs = <R>(store: JsonStore<Job<R>>, { keep, heartbeatMs, now = () => new Date(), log = console.error }: JobsOptions) => {
  const prune = async () => {
    const newest = (await store.all()).sort((a, b) => b.started.localeCompare(a.started) || b.id.localeCompare(a.id));
    for (const old of newest.slice(keep)) await store.remove(old.id);
  };

  return {
    /**
     * Starts `work` and gives its ID once it's stored as running. `signal` is
     * aborted if the job is removed while it runs, made one too many by later
     * starts, and then how it went isn't written.
     */
    async start(work: (signal: AbortSignal, id: string) => Promise<R>) {
      const id = crypto.randomUUID();
      const started = now().toISOString();
      await store.write(id, { id, state: "running", started, heartbeat: started });
      await prune();

      const controller = new AbortController();
      // One write at a time, so a heartbeat can't land after the outcome.
      let writes = Promise.resolve();
      const queue = (write: () => Promise<void>) => (writes = writes.then(write).catch((e) => log(`job ${id}: ${errors.detail(e)}`)));
      const beat = () =>
        queue(async () => {
          if (controller.signal.aborted) return;
          if (!(await store.read(id))) {
            clearInterval(timer);
            return controller.abort();
          }
          await store.write(id, { id, state: "running", started, heartbeat: now().toISOString() });
        });
      const timer = setInterval(beat, heartbeatMs);
      // A heartbeat alone doesn't keep a process running.
      (timer as { unref?: () => void }).unref?.();

      const finish = (outcome: { state: "done"; result: R } | { state: "failed"; error: string }) => {
        clearInterval(timer);
        return queue(async () => {
          if (controller.signal.aborted) return;
          await store.write(id, { id, started, heartbeat: now().toISOString(), ...outcome });
        });
      };
      void Promise.resolve()
        .then(() => work(controller.signal, id))
        .then(
        (result) => finish({ state: "done", result }),
        (error) => {
          log(`job ${id}: ${errors.detail(error)}`);
          return finish({ state: "failed", error: errors.message(error) });
        },
      );
      return id;
    },

    /** How the job `id` is going, or undefined for one never started, removed, or unreadable. */
    async status(id: string): Promise<JobStatus<R> | undefined> {
      const job = await store.read(id);
      if (!job) return undefined;
      if (job.state === "done") return { state: "done", result: job.result };
      if (job.state === "failed") return { state: "failed", error: job.error };
      // A heartbeat that doesn't parse is as stale as any.
      const age = now().getTime() - Date.parse(job.heartbeat);
      return age <= STALE_BEATS * heartbeatMs ? { state: "running" } : { state: "interrupted" };
    },
  };
};

export type Jobs<R> = ReturnType<typeof jobs<R>>;
