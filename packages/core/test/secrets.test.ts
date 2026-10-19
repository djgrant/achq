import { describe, expect, test } from "bun:test";
import { adminSecret, implementationSecret, containerSecret } from "../src/wire/secrets.ts";

describe("derived secrets", () => {
  test("differ by purpose, App, repo and container, and don't depend on repo case", () => {
    const all = [
      adminSecret("k"),
      implementationSecret("k", "github-app-webhook:1"),
      implementationSecret("k", "github-app-webhook:2"),
      containerSecret("k", "o/r", "dev"),
      containerSecret("k", "o/r", "ops"),
      containerSecret("k", "o/s", "dev"),
      containerSecret("other", "o/r", "dev"),
    ];
    expect(new Set(all).size).toBe(all.length);
    expect(containerSecret("k", "O/R", "dev")).toBe(containerSecret("k", "o/r", "dev"));
  });
});
