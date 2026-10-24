import { expect, test } from "bun:test";
import { time } from "../src/time.ts";

test("minutes says how many minutes, singular for one", () => {
  expect(time.minutes(20 * time.MINUTE_MS)).toBe("20 minutes");
  expect(time.minutes(time.MINUTE_MS)).toBe("1 minute");
  expect(time.minutes(30_000)).toBe("0.5 minutes");
});
