import type { AnyTaskConfig, InferTaskReturn, Runner } from "@pokit/core";
import type * as v from "valibot";

/** A Runner as pok types what a task's `run` is given: only `exec`, though it's given the whole Runner. */
type AnyRunner = { exec(...args: never[]): unknown };

type TaskParams<T> = T extends { params?: infer P } ? (P extends v.GenericSchema ? v.InferInput<P> : undefined) : undefined;

/** The Runner pok gives a task's `run`, for its prompter and to run other tasks. pok 0.10 types it as only what `exec` needs. */
export const runner = (r: AnyRunner) => r as unknown as Runner;

/**
 * Runs `task` with `params` through pok's runner, which parses them with the task's schema, as `r.run` does, but typed:
 * pok 0.10's `r.run` takes any params and gives `void` unless told otherwise.
 */
export const run = <T extends { label: string; params?: v.GenericSchema }>(r: AnyRunner, task: T, ...[params]: undefined extends TaskParams<T> ? [params?: TaskParams<T>] : [params: TaskParams<T>]) =>
  runner(r).run<InferTaskReturn<T>>(task as unknown as AnyTaskConfig, params as Record<string, unknown> | undefined);
