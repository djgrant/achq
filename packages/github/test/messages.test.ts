import { expect, test } from "bun:test";
import { messageId } from "../src/runtime/messages.ts";

test("message IDs sort chronologically as strings, the opening post first", () => {
  const ids = [10, 9, 100, 4_000_000_000, 1].map(messageId);
  expect([...ids, messageId(null)].sort()).toEqual([messageId(null), ...[1, 9, 10, 100, 4_000_000_000].map(messageId)]);
  expect(messageId(10) > messageId(9)).toBe(true);
});
