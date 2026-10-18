import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { achq } from "@achq/core";
import * as railway from "@achq/railway";
import { checkInfra, loadInfra } from "../src/lib/load/infra.ts";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "achq-infra-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("the infra must keep the router and deployer in one project", () => {
  expect(() =>
    checkInfra(
      achq(() => {
        const router = new railway.Router("router", { project: "achq" });
        new railway.Deployer("deployer", { project: "other", router, owners: [] });
      })(),
    ),
  ).toThrow("share one Railway project");
});

test("an achq.infra.ts file, written as the design shows, loads with its imports resolved to achq", async () => {
  fs.writeFileSync(
    path.join(tmp, "achq.infra.ts"),
    `import { achq } from "achq";
import * as github from "achq/github";
import * as railway from "achq/railway";

export default achq(() => {
  const router = new railway.Router("router", { project: "achq" });
  const deployer = new railway.Deployer("deployer", {
    project: "achq",
    router,
    owners: ["djgrant", "notationlabs"],
  });
  new github.App("personal", { name: "djgrant-claude", router, deployer });
  new github.App("notation", { name: "notation-achq", org: "notationlabs", router, deployer });
});
`,
  );
  const loaded = await loadInfra(path.join(tmp, "achq.infra.ts"));
  expect(loaded.project).toBe("achq");
  expect(loaded.deployer.inputs.owners).toEqual(["djgrant", "notationlabs"]);
  expect(loaded.apps.map((a) => [a.inputs.name, a.inputs.org])).toEqual([["djgrant-claude", undefined], ["notation-achq", "notationlabs"]]);
});
