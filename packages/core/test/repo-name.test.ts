import { expect, test } from "bun:test";
import { repoName } from "../src/contracts/code-host-provider.ts";

test("repoName.pattern takes owner/name with word characters, dots and dashes, and no segment that's only dots", () => {
  for (const ok of ["acme/widgets", "a.b/c-d.e", "acme/.github", "acme/...x", "_/x_"]) expect(repoName.pattern.test(ok)).toBe(true);
  for (const bad of ["acme/..", "../widgets", "./x", "acme/.", "acme/...", "acme", "acme/widgets/x", "acme/wid gets", "/widgets", "acme/"]) expect(repoName.pattern.test(bad)).toBe(false);
});

test("repoName.segment matches whole segments inside a larger pattern", () => {
  const route = new RegExp(`^/repos/(${repoName.segment})/(${repoName.segment})$`);
  expect(route.exec("/repos/a.b/c-d")?.slice(1)).toEqual(["a.b", "c-d"]);
  expect(route.test("/repos/acme/..")).toBe(false);
  expect(route.test("/repos/.../widgets")).toBe(false);
});
