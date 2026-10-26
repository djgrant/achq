import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "@achq/core";
import { achq } from "@achq/core";
import * as claude from "@achq/claude/infra";
import * as github from "@achq/github/infra";
import * as railway from "@achq/railway/infra";
import { infraChecks } from "../checks/infra.ts";
import { linkWorkspace } from "@achq/test-utils/helpers/plugins";
import { checkInfra, infraLoad } from "../tasks/infra.load.ts";
import { run } from "../tasks/run.ts";
import { testRunner } from "./runner.ts";

let tmp: string;
beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "achq-infra-"));
  // An infra repo, with core and the plugins it imports installed: this checkout's.
  const dependencies = Object.fromEntries(["@achq/core", "@achq/claude", "@achq/github", "@achq/railway"].map((name) => [name, "0.1.0"]));
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ dependencies }));
  await linkWorkspace(tmp);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const nothing = new core.Output<any>([], () => core.UNKNOWN);

/** A container provider achq never ships: the infra brings it. */
const elsewhere = { id: "elsewhere", privateEnv: [] } as unknown as core.ContainerProviderImplementation;

class ElsewhereRouter extends core.Router {
  readonly plugin = core.CORE_PLUGIN;
  readonly provider = elsewhere;
  readonly url = nothing;
  protected readonly placement = undefined as unknown as core.Placement;
}

class ElsewhereDeployer extends core.Deployer {
  readonly plugin = core.CORE_PLUGIN;
  readonly provider = elsewhere;
  protected readonly placement = undefined as unknown as core.Placement;
  constructor(
    name: string,
    readonly inputs: { router: core.Router; owners: string[] },
  ) {
    super(name);
  }
}

test("the router and deployer must run on one container provider, which needn't be one achq ships", () => {
  expect(() =>
    checkInfra(
      achq(() => {
        const router = new railway.Router("router", { project: "achq" });
        new ElsewhereDeployer("deployer", { router, owners: [] });
      })(),
    ),
  ).toThrow("must share a container provider");
  const own = checkInfra(
    achq(() => {
      new ElsewhereDeployer("deployer", { router: new ElsewhereRouter("router"), owners: [] });
      new github.CodeHost("github");
    })(),
  );
  expect(own.deployer.provider).toBe(elsewhere);
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

test("an achq.infra.ts file, written as the design shows, loads with its imports resolved where the infra repo installed them", async () => {
  fs.writeFileSync(
    path.join(tmp, "achq.infra.ts"),
    `import { achq } from "@achq/core";
import * as claude from "@achq/claude/infra";
import * as claude from "@achq/claude/infra";
import * as github from "@achq/github/infra";
import * as railway from "@achq/railway/infra";

export default achq(() => {
  const router = new railway.Router("router", { project: "achq" });
  new railway.Deployer("deployer", {
    router,
    owners: ["djgrant", "notationlabs"],
  });
  new github.Channel("personal", { name: "djgrant-claude", router });
  new github.Channel("notation", { name: "notation-achq", org: "notationlabs", router });
  new github.CodeHost("github");
  new claude.AgentRuntime("claude");
});
`,
  );
  const loaded = await run(testRunner(), infraLoad, { file: path.join(tmp, "achq.infra.ts") });
  expect(loaded.router.containerProvider).toBe("railway");
  expect(loaded.deployer.inputs.owners).toEqual(["djgrant", "notationlabs"]);
  const channels = loaded.resources.filter((r) => r.kind === "github-channel");
  expect(channels.map((c) => [(c as any).inputs.name, (c as any).inputs.org])).toEqual([["djgrant-claude", undefined], ["notation-achq", "notationlabs"]]);
  // Installed here as this checkout, so the infra's channel is the class this test imported.
  expect(channels[0]).toBeInstanceOf(github.Channel);
  expect(loaded.codeHost.implementation.id).toBe("github");
  expect(loaded.runtimes.map((r) => [r.id, r.containerEnv.map((e) => e.name)])).toEqual([["claude", ["CLAUDE_CODE_OAUTH_TOKEN"]]]);
});

test("the infra declares one code host, and each agent runtime once", () => {
  const declare = (more: () => void) =>
    achq(() => {
      const router = new railway.Router("router", { project: "achq" });
      new railway.Deployer("deployer", { router, owners: [] });
      more();
    })();
  expect(() => checkInfra(declare(() => {}))).toThrow("The infra must declare one code host");
  expect(() => checkInfra(declare(() => [new github.CodeHost("a"), new github.CodeHost("b")]))).toThrow("The infra must declare one code host");
  expect(() => checkInfra(declare(() => [new github.CodeHost("github"), new claude.AgentRuntime("a"), new claude.AgentRuntime("b")]))).toThrow("Runtimes a and b are both claude");
  expect(checkInfra(declare(() => new github.CodeHost("github"))).runtimes).toEqual([]);
});

test("before reaching the infra, achq checks what its container provider does, and that the agents' variables are set", async () => {
  fs.writeFileSync(
    path.join(tmp, "achq.infra.ts"),
    `import { achq } from "@achq/core";
import * as claude from "@achq/claude/infra";
import * as github from "@achq/github/infra";
import * as railway from "@achq/railway/infra";
export default achq(() => {
  const router = new railway.Router("router", { project: "achq" });
  new railway.Deployer("deployer", { router, owners: [] });
  new github.CodeHost("github");
  new claude.AgentRuntime("claude");
});
`,
  );
  const checks = await infraChecks(path.join(tmp, "achq.infra.ts"), {});
  expect(checks.map((c) => c.label)).toEqual(["Railway token", "Agent container variables"]);
  await expect(checks[0]!.check()).rejects.toThrow("Missing RAILWAY_API_TOKEN");
  await expect(checks[1]!.check()).rejects.toThrow("Missing CLAUDE_CODE_OAUTH_TOKEN");
  const set = await infraChecks(path.join(tmp, "achq.infra.ts"), { CLAUDE_CODE_OAUTH_TOKEN: "t" });
  await expect(set[1]!.check()).resolves.toBeUndefined();
});
