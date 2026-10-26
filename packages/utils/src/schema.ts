// What achq's schemas share: they're Valibot's, which any Standard Schema consumer (a route, a store's
// collection) also takes. A JSON value, a type a schema's output must fit, and a failure as one line.
import type { StandardSchemaV1 } from "@standard-schema/spec";
import * as v from "valibot";
import type { Json } from "./json.ts";

/** A schema whose output is `T`, for `satisfies`: a schema written beside a plain type must read it. Its input is whatever it accepts. */
export type Reads<T> = v.GenericSchema<any, T>;

/** Any JSON value. */
const json: v.GenericSchema<Json> = v.lazy(() => v.union([v.string(), v.number(), v.boolean(), v.null(), v.array(json), v.record(v.string(), json)]));

/** An issue, as Standard Schema or Valibot reports it: a path segment is a key, or an object with one. */
type Issue = { readonly message: string; readonly path?: readonly unknown[] };

/** The first thing wrong with a value, e.g. `containers.0.name: Invalid type: Expected string but received undefined`. */
const firstIssue = (issues: readonly Issue[]) => {
  const issue = issues[0];
  if (!issue) return "invalid";
  const path = (issue.path ?? []).map((p) => String(p !== null && typeof p === "object" && "key" in p ? p.key : p));
  return path.length ? `${path.join(".")}: ${issue.message}` : issue.message;
};

/** `schema`'s output for `value`, or an error saying what's wrong with it, through Standard Schema, so any library's schema will do. */
const parse = async <S extends StandardSchemaV1>(schema: S, value: unknown): Promise<StandardSchemaV1.InferOutput<S>> => {
  const result = await schema["~standard"].validate(value);
  if (result.issues) throw new Error(firstIssue(result.issues));
  return result.value;
};

export const schema = { json, firstIssue, parse };
