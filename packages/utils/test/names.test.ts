import { expect, test } from "bun:test";
import { crypto } from "../src/crypto.ts";
import { names } from "../src/names.ts";

test("slug joins parts as lowercase letters, digits and dashes", () => {
  expect(names.slug(["-My Org", "Repo_Name!!"], 63)).toBe("my-org-repo-name");
});

test("slug cuts one too long to fit, ending in a hash of the whole of it", () => {
  const slug = names.slug(["abcdefghij", "klmnop-qrstuv"], 20);
  expect(slug).toBe(`abcdefghij-${crypto.sha256Hex("abcdefghij-klmnop-qrstuv", 8)}`);
  expect(slug.length).toBeLessThanOrEqual(20);
});
