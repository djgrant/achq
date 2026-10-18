import { afterEach, beforeEach, expect, test } from "bun:test";
import { RailwayClient } from "../src/api.ts";
import { railwayContainerHost } from "../src/runtime/container-host.ts";
import { type FakeRailway, startFakeRailway } from "@achq/test-utils/railway";

let fake: FakeRailway;
let host: ReturnType<typeof railwayContainerHost>;

const spec = { repo: "NotationLabs/yieldstar", name: "dev", dockerfile: ".achq/Dockerfile", branch: "main", env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } };

beforeEach(async () => {
  fake = startFakeRailway();
  const railway = new RailwayClient("t", fake.url);
  const projectId = await railway.createProject("achq", "ws");
  const project = await railway.project(projectId);
  host = railwayContainerHost({ token: "t", projectId, environmentId: project.environmentId, endpoint: fake.url });
  fake.mutations.length = 0;
});
afterEach(() => fake.stop());

test("ensure creates a private service with a volume, and a second ensure changes nothing", async () => {
  const result = await host.ensure(spec);
  expect(result).toEqual({ service: "notationlabs-yieldstar-dev", url: "http://notationlabs-yieldstar-dev.railway.internal:3000" });
  const service = fake.service("notationlabs-yieldstar-dev")!;
  expect(service.settings).toMatchObject({ dockerfilePath: ".achq/Dockerfile", healthcheckPath: "/", sleepApplication: true });
  expect(service.variables).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "tok", ACHQ_REPO: spec.repo, ACHQ_CONTAINER: "dev", ACHQ_BRANCH: "main" });
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

  const changes = await host.plan({ ...spec, env: { CLAUDE_CODE_OAUTH_TOKEN: "new" } });
  expect(changes.map((c) => `${c.op} ${c.target}`)).toEqual([
    "~ notationlabs-yieldstar-dev variables",
    "~ notationlabs-yieldstar-dev private hostname",
    "- notationlabs-yieldstar-dev public domain",
  ]);
  expect(changes[0].detail).toBe("CLAUDE_CODE_OAUTH_TOKEN"); // names, never values
  expect(fake.mutations).toEqual([]); // planning mutates nothing

  await host.ensure({ ...spec, env: { CLAUDE_CODE_OAUTH_TOKEN: "new" } });
  expect(service.domains).toEqual([]);
  expect(service.endpoint!.dnsName).toBe("notationlabs-yieldstar-dev");
  expect(fake.mutations).toEqual(["variableCollectionUpsert", "privateNetworkEndpointRename", "serviceDomainDelete"]);
});

test("the first deploy connects the repo and turns automatic deploys off; later ones deploy the latest commit", async () => {
  await host.ensure(spec);
  expect(await host.state(spec.repo, "dev")).toBe("missing");
  await host.deploy(spec.repo, "dev");
  const service = fake.service("notationlabs-yieldstar-dev")!;
  expect(service.source.repo).toBe(spec.repo);
  expect(service.branch).toBe("main");
  expect(service.autoDeploy).toBe(false);
  expect(service.deployments).toHaveLength(1); // connecting built it; no second build
  expect(await host.state(spec.repo, "dev")).toBe("running");

  fake.mutations.length = 0;
  await host.deploy(spec.repo, "dev");
  expect(fake.mutations).toEqual(["serviceInstanceDeploy"]);

  // Someone turned automatic deploys back on: ensure turns them off.
  service.autoDeploy = true;
  await host.ensure(spec);
  expect(service.autoDeploy).toBe(false);
});

test("list reads services' repo and container, locate says where, remove deletes the volume too", async () => {
  await host.ensure(spec);
  await host.ensure({ ...spec, name: "docs" });
  expect(await host.list()).toEqual([
    { repo: spec.repo, name: "dev", service: "notationlabs-yieldstar-dev" },
    { repo: spec.repo, name: "docs", service: "notationlabs-yieldstar-docs" },
  ]);
  expect(await host.locate(spec.repo, "dev")).toEqual({
    platform: "railway",
    project: host.options.projectId,
    environment: host.options.environmentId,
    service: "notationlabs-yieldstar-dev",
  });

  await host.remove(spec.repo, "dev");
  const project = fake.project("achq")!;
  expect(project.services.map((s) => s.name)).toEqual(["notationlabs-yieldstar-docs"]);
  expect(project.volumes).toHaveLength(1);
  expect(await host.state(spec.repo, "dev")).toBe("missing");
  await host.remove(spec.repo, "dev"); // already gone: nothing to do
});
