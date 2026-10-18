import { describe, expect, test } from "bun:test";
import { adminSecret, providerSecret, containerSecret } from "../src/secrets.ts";

describe("derived secrets", () => {
  test("differ by purpose, App, repo and container, and don't depend on repo case", () => {
    const all = [
      adminSecret("k"),
      providerSecret("k", "github-app-webhook:1"),
      providerSecret("k", "github-app-webhook:2"),
      containerSecret("k", "o/r", "dev"),
      containerSecret("k", "o/r", "ops"),
      containerSecret("k", "o/s", "dev"),
      containerSecret("other", "o/r", "dev"),
    ];
    expect(new Set(all).size).toBe(all.length);
    expect(containerSecret("k", "O/R", "dev")).toBe(containerSecret("k", "o/r", "dev"));
  });
});
