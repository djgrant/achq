import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "@achq/core";
import { achq } from "@achq/core";
import * as github from "@achq/github/infra";
import * as railway from "@achq/railway/infra";
import { agentEnvCheck, checkInfra, infraChecks, loadInfra } from "../src/lib/infra.ts";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "achq-infra-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const nothing = new core.Output<any>([], () => core.UNKNOWN);

class ElsewhereRouter extends core.Router {
  readonly containerProvider = "elsewhere";
  readonly url = nothing;
  protected readonly placement = undefined as unknown as core.Placement;
}

class ElsewhereDeployer extends core.Deployer {
  readonly containerProvider = "elsewhere";
  protected readonly placement = undefined as unknown as core.Placement;
  constructor(
    name: string,
    readonly inputs: { router: core.Router; owners: string[] },
  ) {
    super(name);
  }
}

test("the router and deployer must run on one container provider, one achq can put containers on", () => {
  expect(() =>
    checkInfra(
      achq(() => {
        const router = new railway.Router("router", { project: "achq" });
        new ElsewhereDeployer("deployer", { router, owners: [] });
      })(),
    ),
  ).toThrow("must share a container provider");
  expect(() =>
    checkInfra(
      achq(() => {
        new ElsewhereDeployer("deployer", { router: new ElsewhereRouter("router"), owners: [] });
      })(),
    ),
  ).toThrow(/doesn't know the .*"elsewhere"/);
});

test("the deployer and every resource that names a router use the infra's", () => {
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
    new railway.Deployer("deployer", { router, owners: [] });
    new github.Channel("personal", { name: "djgrant-claude", router });
  })();
  const elsewhere = achq(() => {
    const router = new railway.Router("router", { project: "achq" });
    new railway.Deployer("deployer", { router, owners: [] });
  })();
  // A channel on another infra's router, declared alongside this one.
  const stray = declared.resources.find((r) => r instanceof github.Channel)!;
  expect(() => checkInfra({ resources: [...elsewhere.resources, stray] })).toThrow("github-channel personal must use router router");
});

test("an achq.infra.ts file, written as the design shows, loads with its imports resolved to achq", async () => {
  fs.writeFileSync(
    path.join(tmp, "achq.infra.ts"),
    `import { achq, github, railway } from "achq/infra";

export default achq(() => {
  const router = new railway.Router("router", { project: "achq" });
  new railway.Deployer("deployer", {
    router,
    owners: ["djgrant", "notationlabs"],
  });
  new github.Channel("personal", { name: "djgrant-claude", router });
  new github.Channel("notation", { name: "notation-achq", org: "notationlabs", router });
});
`,
  );
  const loaded = await loadInfra(path.join(tmp, "achq.infra.ts"));
  expect(loaded.router.containerProvider).toBe("railway");
  expect(loaded.deployer.inputs.owners).toEqual(["djgrant", "notationlabs"]);
  const channels = loaded.resources.filter((r) => r.kind === "github-channel");
  expect(channels.map((c) => [(c as any).inputs.name, (c as any).inputs.org])).toEqual([["djgrant-claude", undefined], ["notation-achq", "notationlabs"]]);
  // The infra's channel is the class the CLI knows: its imports resolved to this checkout.
  expect(channels[0]).toBeInstanceOf(github.Channel);
});

test("before reaching the infra, achq checks what its container provider does, and that the agents' variables are set", async () => {
  fs.writeFileSync(
    path.join(tmp, "achq.infra.ts"),
    `import { achq, railway } from "achq/infra";
export default achq(() => {
  const router = new railway.Router("router", { project: "achq" });
  new railway.Deployer("deployer", { router, owners: [] });
});
`,
  );
  const checks = await infraChecks(path.join(tmp, "achq.infra.ts"), {});
  expect(checks.map((c) => c.label)).toEqual(["Railway token"]);
  await expect(checks[0]!.check()).rejects.toThrow("Missing RAILWAY_API_TOKEN");
  await expect(agentEnvCheck({}).check()).rejects.toThrow("Missing CLAUDE_CODE_OAUTH_TOKEN");
  await expect(agentEnvCheck({ CLAUDE_CODE_OAUTH_TOKEN: "t" }).check()).resolves.toBeUndefined();
});
