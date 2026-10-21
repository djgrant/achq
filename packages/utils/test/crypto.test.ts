import { expect, test } from "bun:test";
import { crypto } from "../src/crypto.ts";

test("hmacHex is HMAC-SHA256 as hex", () => {
  // RFC 4231 test case 2.
  expect(crypto.hmacHex("Jefe", "what do ya want for nothing?")).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
});

test("safeEqual compares strings, of any lengths", () => {
  expect(crypto.safeEqual("abc", "abc")).toBe(true);
  expect(crypto.safeEqual("abc", "abd")).toBe(false);
  expect(crypto.safeEqual("abc", "abcd")).toBe(false);
});

test("sha256Hex cuts to a length when asked", () => {
  const full = crypto.sha256Hex("abc");
  expect(full).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(crypto.sha256Hex("abc", 8)).toBe(full.slice(0, 8));
});

test("randomHex gives two hex characters per byte, fresh each time", () => {
  expect(crypto.randomHex(16)).toMatch(/^[0-9a-f]{32}$/);
  expect(crypto.randomHex(16)).not.toBe(crypto.randomHex(16));
});
