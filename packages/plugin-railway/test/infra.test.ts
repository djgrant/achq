import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as core from "@achq/core";
import { achq, type Change, type Context, type Output, plan, teardown, UNKNOWN } from "@achq/core";
import { type FakeRailway, startFakeRailway } from "@achq/test-utils/railway";
import { Deployer, Router } from "../src/infra.ts";
import { Railway } from "@achq/utils/railway";
import { fingerprint } from "../src/lib/deployment.ts";
import { startCommand } from "../src/lib/service-parts.ts";

let fake: FakeRailway;
let logs: string[];
let ctx: Context;
/** How many times applying waited between checks of a deploy, and what happens when it does. */
let sleeps: number;
let onSleep: () => void;

beforeEach(() => {
  fake = startFakeRailway();
  logs = [];
  sleeps = 0;
  onSleep = () => {};
  ctx = {
    env: { RAILWAY_API_TOKEN: "railway-token", RAILWAY_API_URL: fake.url, RAILWAY_WORKSPACE_ID: "ws" },
    log: (line) => logs.push(line),
    newSecret: () => "generated-key",
    sleep: async () => {
      sleeps++;
      onSleep();
    },
  };
});
afterEach(() => fake.stop());

/** The router and deployer: the deployer takes the router's generated key and its public URL. */
const declare = (ref = "a", appId = "7") => {
  let router!: Router;
  let deployer!: Deployer;
  achq(() => {
    router = new Router("router", { project: "achq" });
    router.variables({ ACHQ_REF: ref });
    router.variables({ GITHUB_APP_ID: appId });
    deployer = new Deployer("deployer", { router, owners: [] });
    deployer.variables({ AGENT_WEBHOOK_KEY: router.key, ACHQ_ROUTER_PUBLIC_URL: router.url, ACHQ_ROUTER_URL: router.privateUrl(8080), ACHQ_REF: ref });
  })();
  return { router, deployer, resources: [router, deployer] };
};

const summary = (changes: Change[]) => changes.map((c) => [`${c.op} ${c.target} ${c.what}`, c.detail ?? c.names?.join(", ")].filter(Boolean).join(" "));

const url = "https://achq-router-production.up.railway.app";

test("a new project plans in one pass and writes nothing, with the router's URL known only after apply; a second plan is empty", async () => {
  const { router, resources } = declare();
  const planned = await plan(resources, ctx);
  expect(summary(planned.changes)).toEqual([
    "+ achq railway project",
    "+ achq-router service",
    "+ achq-router volume /data",
    "+ achq-router public domain → :8080",
    "~ achq-router variables AGENT_WEBHOOK_KEY, DATA_DIR, PORT",
    "~ achq-router variables ACHQ_REF",
    "~ achq-router variables GITHUB_APP_ID",
    "~ achq-router deploy",
    "+ achq-deployer service",
    "+ achq-deployer volume /data",
    "~ achq-deployer variables RAILWAY_API_TOKEN, ACHQ_RAILWAY_PROJECT_ID, ACHQ_RAILWAY_ENVIRONMENT_ID, DATA_DIR, PORT",
    "~ achq-deployer variables AGENT_WEBHOOK_KEY, ACHQ_ROUTER_PUBLIC_URL, ACHQ_ROUTER_URL, ACHQ_REF",
    "~ achq-deployer deploy",
  ]);
  expect(planned.value(router.url)).toBe(UNKNOWN);
  expect(planned.value(router.key)).toBe("generated-key");
  expect(planned.value(router.env)).toEqual({});
  expect(fake.mutations).toEqual([]);

  const applied = await planned.apply();
  expect(applied.value(router.url)).toBe(url);
  // Read before the service was made.
  expect(applied.value(router.env)).toEqual({});
  expect(logs).toEqual(["  waiting for the router to deploy…"]);
  const project = fake.project("achq")!;
  expect(fake.service("achq-deployer")!.variables).toMatchObject({
    AGENT_WEBHOOK_KEY: "generated-key",
    ACHQ_ROUTER_PUBLIC_URL: url,
    ACHQ_ROUTER_URL: "http://achq-router.railway.internal:8080",
    RAILWAY_API_TOKEN: "railway-token",
    ACHQ_RAILWAY_PROJECT_ID: project.id,
    ACHQ_RAILWAY_ENVIRONMENT_ID: project.environmentId,
    DATA_DIR: "/data",
    PORT: "3000",
  });
  expect(fake.service("achq-deployer")!.domains).toEqual([]);
  expect(fake.service("achq-deployer")!.settings).toMatchObject({ sleepApplication: true });
  expect(fake.service("achq-router")!.settings).toMatchObject({ healthcheckPath: "/", sleepApplication: false, startCommand: startCommand("packages/service-router/src/main.ts") });
  expect(fake.service("achq-router")!.source.image).toBe("oven/bun:1-slim");
  expect(fake.service("achq-router")!.deployments).toHaveLength(1);
  expect(fake.service("achq-deployer")!.deployments).toHaveLength(1);

  const again = declare();
  const unchanged = await plan(again.resources, ctx);
  expect(unchanged.changes).toEqual([]);
  expect(unchanged.value(again.router.url)).toBe(url);
  expect(unchanged.value(again.router.env)).toMatchObject({ AGENT_WEBHOOK_KEY: "generated-key", PORT: "8080" });
});

test("once applied, nothing changes until an input does, and then only what depends on it", async () => {
  await (await plan(declare().resources, ctx)).apply();
  const b = declare("b");
  const changed = await plan(b.resources, ctx);
  expect(summary(changed.changes)).toEqual(["~ achq-router variables ACHQ_REF", "~ achq-router deploy", "~ achq-deployer variables ACHQ_REF", "~ achq-deployer deploy"]);
  const applied = await changed.apply();
  // Its variables before this run changed them.
  expect(applied.value(b.router.env).ACHQ_REF).toBe("a");
  expect(applied.value(b.deployer.env).ACHQ_REF).toBe("a");
  expect(fake.service("achq-router")!.deployments).toHaveLength(2);
  expect(fake.service("achq-router")!.domains).toHaveLength(1);
  expect(fake.service("achq-router")!.variables.AGENT_WEBHOOK_KEY).toBe("generated-key");
});

test("teardown deletes the project, and every service and volume in it with it", async () => {
  await (await plan(declare().resources, ctx)).apply();
  const planned = await teardown(declare().resources, ctx);
  expect(planned.changes).toEqual([{ op: "-", target: "router/project", what: "railway-project" }]);
  expect(planned.protected).toEqual([]);
  await planned.apply();
  expect(fake.projects).toEqual([]);
  expect((await teardown(declare().resources, ctx)).changes).toEqual([]);
});

test("an existing service gets back a missing volume, its own private hostname and exactly one public domain, without redeploying", async () => {
  await (await plan(declare().resources, ctx)).apply();
  const router = fake.service("achq-router")!;
  const project = fake.project("achq")!;
  project.volumes = project.volumes.filter((v) => v.serviceId !== router.id);
  router.endpoint!.dnsName = "old-name";
  router.domains.push({ id: "dom-x", domain: "stale.up.railway.app", targetPort: 3000 });
  fake.mutations.length = 0;

  const declared = declare();
  const planned = await plan(declared.resources, ctx);
  expect(summary(planned.changes)).toEqual(["+ achq-router volume /data", "~ achq-router private hostname old-name → achq-router", "- achq-router public domain stale.up.railway.app"]);
  expect(fake.mutations).toEqual([]);
  const applied = await planned.apply();
  expect(fake.mutations).toEqual(["volumeCreate", "privateNetworkEndpointRename", "serviceDomainDelete"]);
  expect(applied.value(declared.router.env)).toMatchObject({ ACHQ_REF: "a", PORT: "8080" });
  expect(router.domains.map((d) => d.domain)).toEqual(["achq-router-production.up.railway.app"]);
  expect((await plan(declare().resources, ctx)).changes).toEqual([]);
});

test("a setting changed on Railway is set back without a deploy: the deploy is over what achq wants, which didn't change", async () => {
  await (await plan(declare().resources, ctx)).apply();
  fake.service("achq-router")!.settings.sleepApplication = true;
  expect(summary((await plan(declare().resources, ctx)).changes)).toEqual(["~ achq-router settings sleepApplication"]);
});

test("a service's deploy is over its settings and every group of its variables as one map", async () => {
  const { router } = declare("a", "1");
  await (await plan([router], ctx)).apply();
  const settings = { source: { image: "oven/bun:1-slim" }, startCommand: startCommand("packages/service-router/src/main.ts"), healthcheckPath: "/", sleepApplication: false };
  const variables = { AGENT_WEBHOOK_KEY: "generated-key", ACHQ_REF: "a", GITHUB_APP_ID: "1", DATA_DIR: "/data", PORT: "8080" };
  expect(fake.service("achq-router")!.variables.ACHQ_DEPLOYED).toBe(fingerprint({ settings, variables }));

  expect((await plan([declare("a", "1").router], ctx)).changes).toEqual([]);
  expect(summary((await plan([declare("a", "2").router], ctx)).changes)).toEqual(["~ achq-router variables GITHUB_APP_ID", "~ achq-router deploy"]);
});

test("a router deployed before variables came in groups doesn't redeploy: its fingerprint is over the groups' union", async () => {
  // A router as the single-map planner left it, with ACHQ_DEPLOYED hashed as it hashed it.
  const railway = new Railway("t", fake.url);
  const { id: projectId, environmentId } = await railway.readProject(await railway.createProject("achq", "ws"));
  const service = await railway.project({ projectId, environmentId }).createService("achq-router");
  const settings = { source: { image: "oven/bun:1-slim" }, startCommand: startCommand("packages/service-router/src/main.ts"), healthcheckPath: "/", sleepApplication: false };
  const variables = { AGENT_WEBHOOK_KEY: "old-key", ACHQ_REF: "a", GITHUB_APP_ID: "7", DATA_DIR: "/data", PORT: "8080" };
  const sorted = Object.fromEntries(Object.entries(variables).sort(([a], [b]) => a.localeCompare(b)));
  const deployed = createHash("sha256").update(JSON.stringify({ settings, variables: sorted })).digest("hex").slice(0, 16);
  await service.update(settings);
  await service.addVolume("/data");
  await service.addDomain(8080);
  await service.deployImage();
  await service.setVariables({ ...variables, ACHQ_DEPLOYED: deployed });

  expect((await plan([declare().router], ctx)).changes).toEqual([]);
});

test("each variable is in one group, checked when planned, and groups are declared before the service is planned", async () => {
  const port = declare();
  port.router.variables({ PORT: "1" });
  await expect(plan([port.router], ctx)).rejects.toThrow("achq-router: PORT declared in two groups of variables");
  const ref = declare();
  ref.router.variables({ ACHQ_REF: "b" });
  await expect(plan([ref.router], ctx)).rejects.toThrow("achq-router: ACHQ_REF declared in two groups of variables");
  // A group declared with a function is made when it's planned.
  const { router, deployer } = declare();
  deployer.variables(() => ({ ACHQ_REF: "b" }));
  await expect(plan([router, deployer], ctx)).rejects.toThrow("achq-deployer: ACHQ_REF declared in two groups of variables");
  expect(router.children(ctx).map((r) => r.name)).toEqual(["project", "service", "variables", "variables-2", "variables-3", "deploy"]);

  const fresh = declare();
  const late = fresh.router.variables((c) => ({ LATE: c.env.RAILWAY_WORKSPACE_ID! }));
  const planned = await plan(fresh.resources, ctx);
  expect(summary(planned.changes)).toContain("~ achq-router variables LATE");
  expect(planned.value(late)).toEqual({ LATE: "ws" });
  expect(() => fresh.router.variables({ OTHER: "x" })).toThrow("achq-router: variables declared after it was planned");
});

test("declaring the router and deployer reads nothing: only planning does", () => {
  const { router, deployer } = declare();
  expect(router.children(ctx).map((r) => r.name)).toEqual(["project", "service", "variables", "variables-2", "variables-3", "deploy"]);
  expect(deployer.children(ctx).map((r) => r.name)).toEqual(["service", "variables", "variables-2", "deploy"]);
  expect(router.children(ctx).every((r) => r.parent === router)).toBe(true);
  expect(core.declared()).toEqual([router, deployer]);
  expect(fake.queries).toEqual([]);
});

test("planning needs a Railway token", async () => {
  await expect(plan(declare().resources, { ...ctx, env: { RAILWAY_API_URL: fake.url } })).rejects.toThrow("Missing RAILWAY_API_TOKEN");
});

test("the deployer runs in a Railway router's project", () => {
  class Elsewhere extends core.Router {
    readonly containerProvider = "elsewhere";
    readonly url = undefined as unknown as Output<string>;
    readonly env = undefined as unknown as Output<Record<string, string>>;
    protected readonly placement = undefined as unknown as core.Placement;
  }
  expect(() => achq(() => new Deployer("deployer", { router: new Elsewhere("router"), owners: [] }))()).toThrow("router must be a railway.Router");
});

/** Railway's deploys as `status()` says, whatever the fake says. */
const deploysAre = (status: () => string | undefined) => {
  const real = globalThis.fetch;
  return spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    const res = await real(input, init);
    const s = status();
    if (!s || !String(init?.body).includes("serviceInstance(")) return res;
    const json: any = await res.json();
    if (json.data?.serviceInstance?.latestDeployment) json.data.serviceInstance.latestDeployment.status = s;
    return Response.json(json);
  }) as typeof fetch);
};

test("applying waits for the router's deploy to go live, and not the deployer's", async () => {
  let status: string | undefined = "BUILDING";
  const spy = deploysAre(() => status);
  try {
    const { resources } = declare();
    const planned = await plan(resources, ctx);
    onSleep = () => (status = undefined);
    await planned.apply();
    expect(sleeps).toBe(1);
    expect(logs).toEqual(["  waiting for the router to deploy…"]);
  } finally {
    spy.mockRestore();
  }
});

test("a router deploy that fails, or doesn't go live in five minutes, fails the apply", async () => {
  let status = "CRASHED";
  const spy = deploysAre(() => status);
  try {
    const failing = declare();
    const planned = await plan(failing.resources, ctx);
    await expect(planned.apply()).rejects.toThrow("achq-router's deploy crashed; see its logs on Railway");

    status = "BUILDING";
    const slow = declare("b");
    const again = await plan(slow.resources, ctx);
    sleeps = 0;
    await expect(again.apply()).rejects.toThrow("achq-router hasn't deployed after 5 minutes");
    expect(sleeps).toBe(60);
  } finally {
    spy.mockRestore();
  }
});
