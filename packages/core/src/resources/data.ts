import { type Json, sameJson, stableStringify, toJsonValue } from "@achq/utils/json";

export type Data = Json;

export { stableStringify };

export const sameData: (a: Data, b: Data) => boolean = sameJson;

/**
 * Converts a value to Data, or throws naming the path that isn't plain data.
 * `undefined` object fields are dropped, as JSON would.
 */
export const toData: (value: unknown, at?: string) => Data = toJsonValue;
