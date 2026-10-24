import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type FakeRailway, startFakeRailway } from "@achq/test-utils/railway";
import { railwayContainerProvider } from "../src/container/index.ts";
import { RailwayContainerProvider } from "../src/container/provider.ts";
import { Railway } from "@achq/utils/railway";
import { BrowserActionNeeded } from "@achq/core";

const NO_BUILD = { build: false };
const BUILD = { build: true };

let fake: FakeRailway;
let host: RailwayContainerProvider;

const spec = {
  repo: "NotationLabs/yieldstar",
  identity: { id: "22", name: "yieldstar", owner: { id: "11", name: "NotationLabs" } },
  name: "dev",
  dockerfile: ".achq/Dockerfile",
  branch: "main",
  // As the deployer sets them.
  env: {
    CLAUDE_CODE_OAUTH_TOKEN: "tok",
    ACHQ_REPO: "NotationLabs/yieldstar",
    ACHQ_CONTAINER: "dev",
    ACHQ_ROUTER_URL: "http://router.internal:8081",
  },
};

beforeEach(async () => {
  fake = startFakeRailway();
  const railway = new Railway("t", fake.url);
  const projectId = await railway.createProject("achq", "ws");
  const project = await railway.readProject(projectId);
  host = new RailwayContainerProvider({ token: "t", projectId, environmentId: project.environmentId, endpoint: fake.url });
  fake.mutations.length = 0;
});
afterEach(() => fake.stop());

test("ensure creates a private service with a volume, and a second ensure changes nothing", async () => {
  const result = await host.ensure(spec, NO_BUILD);
  expect(result).toEqual({ url: "http://notationlabs-yieldstar-dev.railway.internal:3000" });
  const service = fake.service("notationlabs-yieldstar-dev")!;
  expect(service.settings).toMatchObject({ dockerfilePath: ".achq/Dockerfile", healthcheckPath: "/", sleepApplication: true });
  expect(service.variables).toEqual({
    ...spec.env,
    DATA_DIR: "/data",
    PORT: "3000",
    ACHQ_KEEP_AWAKE_URL: "http://router.internal:8081/",
  });
  expect(fake.project("achq")!.volumes).toEqual([expect.objectContaining({ serviceId: service.id, mountPath: "/data" })]);
  expect(fake.mutations).not.toContain("serviceDomainCreate");
  expect(fake.mutations).not.toContain("serviceConnect"); // ensure doesn't build

  const before = fake.mutations.length;
  await host.ensure(spec, NO_BUILD);
  expect(fake.mutations.length).toBe(before);
});

test("a build of a repo Railway's GitHub App can't see fails with where to install it, and builds once it can", async () => {
  fake.unseenRepos.add(spec.repo);
  const failure = await host.ensure(spec, BUILD).catch((e) => e);
  expect(failure).toBeInstanceOf(BrowserActionNeeded);
  expect(failure.action).toEqual({ url: "https://github.com/apps/railway-app/installations/new", what: "install railway-app on NotationLabs/yieldstar" });

  fake.unseenRepos.clear();
  await host.ensure(spec, BUILD);
  expect(fake.service("notationlabs-yieldstar-dev")!.deployments).toEqual([expect.objectContaining({ status: "SUCCESS" })]);
});

test("ensure removes a public domain and fixes the private hostname, and only changes what differs", async () => {
  await host.ensure(spec, BUILD);
  const service = fake.service("notationlabs-yieldstar-dev")!;
  service.domains.push({ id: "dom-x", domain: "leaked.up.railway.app", targetPort: 3000 });
  service.endpoint!.dnsName = "old-name";
  fake.mutations.length = 0;

  await host.ensure({ ...spec, env: { ...spec.env, CLAUDE_CODE_OAUTH_TOKEN: "new" } }, NO_BUILD);
  expect(service.domains).toEqual([]);
  expect(service.endpoint!.dnsName).toBe("notationlabs-yieldstar-dev");
  expect(service.variables.CLAUDE_CODE_OAUTH_TOKEN).toBe("new");
  expect(fake.mutations).toEqual(["privateNetworkEndpointRename", "serviceDomainDelete", "variableCollectionUpsert"]);
});

test("the first build connects the repo to the spec's branch and turns automatic deploys off; later ones deploy the latest commit", async () => {
  await host.ensure(spec, NO_BUILD);
  const service = fake.service("notationlabs-yieldstar-dev")!;
  expect(service.deployments).toEqual([]);
  await host.ensure(spec, BUILD);
  expect(service.source.repo).toBe(spec.repo);
  expect(service.branch).toBe("main");
  expect(service.autoDeploy).toBe(false);
  expect(service.deployments).toEqual([expect.objectContaining({ status: "SUCCESS" })]); // connecting built it; no second build

  fake.mutations.length = 0;
  await host.ensure(spec, BUILD);
  expect(fake.mutations).toEqual(["serviceInstanceDeploy"]);

  // Someone turned automatic deploys back on: ensure turns them off, and builds nothing.
  service.autoDeploy = true;
  fake.mutations.length = 0;
  await host.ensure(spec, NO_BUILD);
  expect(fake.mutations).toEqual(["serviceInstanceAutoDeployUpdate"]);
  expect(service.autoDeploy).toBe(false);
});

test("list reads services' repo and container, locate says where, remove deletes the volume too", async () => {
  await host.ensure(spec, NO_BUILD);
  await host.ensure({ ...spec, name: "docs", env: { ...spec.env, ACHQ_CONTAINER: "docs" } }, NO_BUILD);
  expect(await host.list()).toEqual([
    { repo: spec.repo, name: "dev" },
    { repo: spec.repo, name: "docs" },
  ]);
  expect(await host.locate(spec.repo, "dev")).toEqual({
    containerProvider: "railway",
    project: host.options.projectId,
    environment: host.options.environmentId,
    service: "notationlabs-yieldstar-dev",
  });

  await host.remove(spec.repo, "dev");
  const project = fake.project("achq")!;
  expect(project.services.map((s) => s.name)).toEqual(["notationlabs-yieldstar-docs"]);
  expect(project.volumes).toHaveLength(1);
  await host.remove(spec.repo, "dev"); // already gone: nothing to do
});

test("the deployer makes it from its environment: the token and the project", async () => {
  expect(railwayContainerProvider.id).toBe("railway");
  expect(railwayContainerProvider.privateEnv).toEqual(["RAILWAY_API_TOKEN", "RAILWAY_TOKEN"]);
  expect(() => railwayContainerProvider.create({ RAILWAY_API_TOKEN: "t" })).toThrow("Missing ACHQ_RAILWAY_PROJECT_ID");
  const made = railwayContainerProvider.create({
    RAILWAY_API_TOKEN: "t",
    RAILWAY_API_URL: fake.url,
    ACHQ_RAILWAY_PROJECT_ID: host.options.projectId,
    ACHQ_RAILWAY_ENVIRONMENT_ID: host.options.environmentId,
  });
  expect(await made.ensure(spec, NO_BUILD)).toEqual({ url: "http://notationlabs-yieldstar-dev.railway.internal:3000" });
  expect(fake.service("notationlabs-yieldstar-dev")).toBeDefined();
});

test("the router and deployer keep what they store as files on their volume, under DATA_DIR, readable by them alone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "achq-railway-store-"));
  const store = railwayContainerProvider.store<{ n: number }>({ DATA_DIR: dir }, "inbox");
  await store.write("d-1", { n: 1 });
  expect(await store.all()).toEqual([{ n: 1 }]);
  expect(fs.statSync(path.join(dir, "inbox", "d-1.json")).mode & 0o777).toBe(0o600);
  expect(() => railwayContainerProvider.store({}, "inbox")).toThrow("Missing DATA_DIR");
});
