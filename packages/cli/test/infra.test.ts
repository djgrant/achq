import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { achq } from "@achq/core";
import { graph } from "@achq/reconcile";
import * as railway from "@achq/railway";
import { RailwayClient } from "@achq/railway/api";
import { checkInfra, loadInfra } from "../src/lib/load/infra.ts";
import { expandInfra } from "../src/lib/up/expand.ts";
import { infraExpanders } from "../src/lib/up/expanders.ts";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "achq-infra-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Expanding reads and changes nothing, so these clients are never called. */
const expanders = () =>
  infraExpanders({ railway: new RailwayClient("unused"), ref: "abc", tokens: { railway: "r", claude: "c" }, createApp: async () => { throw new Error("unused"); }, log: () => {} });

test("Railway keeps the router and deployer in one project, which it checks before reading anything", () => {
  const infra = checkInfra(
    achq(() => {
      const router = new railway.Router("router", { project: "achq" });
      new railway.Deployer("deployer", { project: "other", router, owners: [] });
    })(),
  );
  expect(() => expandInfra(infra.resources, expanders(), graph())).toThrow("share one Railway project");
});

test("a resource no platform implements is named", () => {
  const infra = checkInfra(
    achq(() => {
      const router = new railway.Router("router", { project: "achq" });
      new railway.Deployer("deployer", { project: "achq", router, owners: [] });
    })(),
  );
  expect(() => expandInfra(infra.resources, [], graph())).toThrow("Nothing here can run router router");
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
  expect(loaded.router).toBeInstanceOf(railway.Router);
  expect(loaded.deployer.inputs.owners).toEqual(["djgrant", "notationlabs"]);
  expect(loaded.apps.map((a) => [a.inputs.name, a.inputs.org])).toEqual([["djgrant-claude", undefined], ["notation-achq", "notationlabs"]]);
});
