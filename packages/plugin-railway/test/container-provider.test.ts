import { afterEach, beforeEach, expect, test } from "bun:test";
import { type FakeRailway, startFakeRailway } from "@achq/test-utils/railway";
import { railwayContainerProvider } from "../src/container/index.ts";
import { RailwayContainerProvider } from "../src/container/provider.ts";
import { Railway } from "@achq/utils/railway";

let fake: FakeRailway;
let host: RailwayContainerProvider;

const spec = {
  host: "github",
  repo: "NotationLabs/yieldstar",
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
  expect((await host.plan(spec)).map((c) => `${c.op} ${c.target}`)).toEqual([
    "+ service notationlabs-yieldstar-dev",
    "+ notationlabs-yieldstar-dev volume",
    "~ notationlabs-yieldstar-dev variables",
  ]);
  expect(fake.mutations).toEqual([]);
  const result = await host.ensure(spec);
  expect(result).toEqual({ url: "http://notationlabs-yieldstar-dev.railway.internal:3000" });
  const service = fake.service("notationlabs-yieldstar-dev")!;
  expect(service.settings).toMatchObject({ dockerfilePath: ".achq/Dockerfile", healthcheckPath: "/", sleepApplication: true });
  // The deployer's variables, and the host's own.
  expect(service.variables).toEqual({
    ...spec.env,
    ACHQ_BRANCH: "main",
    DATA_DIR: "/data",
    PORT: "3000",
    ACHQ_KEEP_AWAKE_URL: "http://router.internal:8081/",
  });
  expect(fake.project("achq")!.volumes).toEqual([expect.objectContaining({ serviceId: service.id, mountPath: "/data" })]);
  expect(fake.mutations).not.toContain("serviceDomainCreate");
  expect(fake.mutations).not.toContain("serviceConnect"); // ensure doesn't build

  const before = fake.mutations.length;
  expect(await host.plan(spec)).toEqual([]);
  await host.ensure(spec);
  expect(fake.mutations.length).toBe(before);
});

test("ensure removes a public domain and fixes the private hostname, and only changes what differs", async () => {
  await host.ensure(spec);
  await host.deploy(spec.repo, "dev");
  const service = fake.service("notationlabs-yieldstar-dev")!;
  service.domains.push({ id: "dom-x", domain: "leaked.up.railway.app", targetPort: 3000 });
  service.endpoint!.dnsName = "old-name";
  fake.mutations.length = 0;

  const changes = await host.plan({ ...spec, env: { ...spec.env, CLAUDE_CODE_OAUTH_TOKEN: "new" } });
  expect(changes.map((c) => `${c.op} ${c.target}`)).toEqual([
    "~ notationlabs-yieldstar-dev private hostname",
    "- notationlabs-yieldstar-dev public domain",
    "~ notationlabs-yieldstar-dev variables",
  ]);
  expect(changes[2].detail).toBe("CLAUDE_CODE_OAUTH_TOKEN"); // names, never values
  expect(fake.mutations).toEqual([]); // planning mutates nothing

  await host.ensure({ ...spec, env: { ...spec.env, CLAUDE_CODE_OAUTH_TOKEN: "new" } });
  expect(service.domains).toEqual([]);
  expect(service.endpoint!.dnsName).toBe("notationlabs-yieldstar-dev");
  expect(fake.mutations).toEqual(["privateNetworkEndpointRename", "serviceDomainDelete", "variableCollectionUpsert"]);
});

test("the first deploy connects the repo and turns automatic deploys off; later ones deploy the latest commit", async () => {
  await host.ensure(spec);
  const service = fake.service("notationlabs-yieldstar-dev")!;
  expect(service.deployments).toEqual([]);
  await host.deploy(spec.repo, "dev");
  expect(service.source.repo).toBe(spec.repo);
  expect(service.branch).toBe("main");
  expect(service.autoDeploy).toBe(false);
  expect(service.deployments).toEqual([expect.objectContaining({ status: "SUCCESS" })]); // connecting built it; no second build

  fake.mutations.length = 0;
  await host.deploy(spec.repo, "dev");
  expect(fake.mutations).toEqual(["serviceInstanceDeploy"]);

  // Someone turned automatic deploys back on: ensure turns them off, and builds nothing.
  service.autoDeploy = true;
  expect(await host.plan(spec)).toEqual([{ op: "-", target: "notationlabs-yieldstar-dev automatic deploys" }]);
  fake.mutations.length = 0;
  await host.ensure(spec);
  expect(fake.mutations).toEqual(["serviceInstanceAutoDeployUpdate"]);
  expect(service.autoDeploy).toBe(false);
});

test("list reads services' repo and container, locate says where, remove deletes the volume too", async () => {
  await host.ensure(spec);
  await host.ensure({ ...spec, name: "docs", env: { ...spec.env, ACHQ_CONTAINER: "docs" } });
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

test("only builds repos on GitHub", async () => {
  await expect(host.ensure({ ...spec, host: "gitlab" })).rejects.toThrow("Railway builds containers from github repos, not gitlab");
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
  expect(await made.ensure(spec)).toEqual({ url: "http://notationlabs-yieldstar-dev.railway.internal:3000" });
  expect(fake.service("notationlabs-yieldstar-dev")).toBeDefined();
});
