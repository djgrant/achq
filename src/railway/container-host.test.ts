import { afterEach, beforeEach, expect, test } from "bun:test";
import { RailwayClient } from "./client.ts";
import { containerServiceName, railwayContainerHost } from "./container-host.ts";
import { type FakeRailway, startFakeRailway } from "./fake.ts";
import { routerServiceSpec } from "./hosts.ts";
import { planService, serviceName } from "./service.ts";

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

test("service names are lowercase, dash-separated and fit a hostname", () => {
  expect(containerServiceName("NotationLabs/yieldstar.dev", "dev")).toBe("notationlabs-yieldstar-dev-dev");
  const long = serviceName("a".repeat(40), "b".repeat(40));
  expect(long.length).toBeLessThanOrEqual(63);
  expect(long).not.toBe(serviceName("a".repeat(40), "b".repeat(39), "c"));
});

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

test("an image service redeploys only when its config changed, and keeps exactly one public domain", async () => {
  const railway = new RailwayClient("t", fake.url);
  const project = () => railway.project(fake.project("achq")!.id);
  const target = { projectId: fake.project("achq")!.id, environmentId: fake.project("achq")!.environmentId };
  const router = (ref: string) => routerServiceSpec({ name: "achq-router", key: "k", apps: {}, deployerUrl: "http://d", ref });

  const first = await planService(railway, target, router("a"), await project());
  expect(first.changes.map((c) => `${c.op} ${c.target}`)).toEqual(["+ service achq-router", "+ achq-router volume", "+ achq-router public domain", "~ achq-router deploy"]);
  const applied = await first.apply();
  expect(applied.domain).toBe("achq-router-production.up.railway.app");
  expect(fake.service("achq-router")!.deployments).toHaveLength(1);

  expect((await planService(railway, target, router("a"), await project())).changes).toEqual([]);

  const changed = await planService(railway, target, router("b"), await project());
  expect(changed.changes.map((c) => `${c.op} ${c.target} ${c.detail ?? ""}`.trim())).toEqual(["~ achq-router variables ACHQ_REF", "~ achq-router deploy"]);
  await changed.apply();
  expect(fake.service("achq-router")!.deployments).toHaveLength(2);
  expect(fake.service("achq-router")!.domains).toHaveLength(1);
});
