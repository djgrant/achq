import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "@achq/core";
import { achq } from "@achq/core";
import * as github from "@achq/github/infra";
import * as railway from "@achq/railway/infra";
import { checkInfra, loadInfra } from "../src/lib/load/infra.ts";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "achq-infra-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const nothing = new core.Output<any>([], () => core.UNKNOWN);

class ElsewhereRouter extends core.Router {
  readonly containerHost = "elsewhere";
  readonly url = nothing;
  readonly key = nothing;
  readonly env = nothing;
  privateUrl = () => "http://router.elsewhere";
  variables = () => nothing;
}

class ElsewhereDeployer extends core.Deployer {
  readonly containerHost = "elsewhere";
  readonly env = nothing;
  constructor(
    name: string,
    readonly inputs: { router: core.Router; owners: string[] },
  ) {
    super(name);
  }
  privateUrl = () => "http://deployer.elsewhere";
  variables = () => nothing;
}

test("the router and deployer must run on one container host, one achq can put containers on", () => {
  expect(() =>
    checkInfra(
      achq(() => {
        const router = new railway.Router("router", { project: "achq" });
        new ElsewhereDeployer("deployer", { router, owners: [] });
      })(),
    ),
  ).toThrow("must share a container host");
  expect(() =>
    checkInfra(
      achq(() => {
        new ElsewhereDeployer("deployer", { router: new ElsewhereRouter("router"), owners: [] });
      })(),
    ),
  ).toThrow(/doesn't know the .*"elsewhere"/);
});

test("the deployer and every resource that names a router or deployer use the infra's", () => {
  expect(() =>
    checkInfra(
      achq(() => {
        new railway.Router("router", { project: "achq" });
        const other = new railway.Router("other", { project: "achq" });
        new railway.Deployer("deployer", { router: other, owners: [] });
      })(),
    ),
  ).toThrow("one router and one deployer");
  const declared = achq(() => {
    const router = new railway.Router("router", { project: "achq" });
    const deployer = new railway.Deployer("deployer", { router, owners: [] });
    new github.App("personal", { name: "djgrant-claude", router, deployer });
  })();
  const elsewhere = achq(() => {
    const router = new railway.Router("router", { project: "achq" });
    new railway.Deployer("deployer", { router, owners: [] });
  })();
  // An App on another infra's router, declared alongside this one.
  const stray = declared.resources.find((r) => r instanceof github.App)!;
  expect(() => checkInfra({ resources: [...elsewhere.resources, stray] })).toThrow("github-app personal must use router router");
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
    router,
    owners: ["djgrant", "notationlabs"],
  });
  new github.App("personal", { name: "djgrant-claude", router, deployer });
  new github.App("notation", { name: "notation-achq", org: "notationlabs", router, deployer });
});
`,
  );
  const loaded = await loadInfra(path.join(tmp, "achq.infra.ts"));
  expect(loaded.router.containerHost).toBe("railway");
  expect(loaded.deployer.inputs.owners).toEqual(["djgrant", "notationlabs"]);
  const apps = loaded.resources.filter((r) => r.kind === "github-app");
  expect(apps.map((a) => [(a as any).inputs.name, (a as any).inputs.org])).toEqual([["djgrant-claude", undefined], ["notation-achq", "notationlabs"]]);
  // The infra's App is the class the CLI knows: its imports resolved to this checkout.
  expect(apps[0]).toBeInstanceOf(github.App);
});
