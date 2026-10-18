import { afterEach, beforeEach, expect, test } from "bun:test";
import { formatChange, graph } from "@achq/reconcile";
import { type FakeRailway, startFakeRailway } from "@achq/test-utils/railway";
import { RailwayClient } from "../src/api.ts";
import { domainFor } from "../src/runtime/resources/domains.ts";
import type { Place } from "../src/runtime/resources/project.ts";
import { generated, given, secret } from "../src/runtime/resources/secret.ts";
import { sharedVariables } from "../src/runtime/resources/shared-variables.ts";
import { addDeployment, addService } from "../src/runtime/service-nodes.ts";

let fake: FakeRailway;
let railway: RailwayClient;
let place: Place;

beforeEach(async () => {
  fake = startFakeRailway();
  railway = new RailwayClient("t", fake.url);
  const project = await railway.project(await railway.createProject("achq", "ws"));
  place = { projectId: project.id, environmentId: project.environmentId };
  fake.mutations.length = 0;
});
afterEach(() => fake.stop());

const imageService = (ref: string) => {
  const g = graph();
  const spec = {
    name: "achq-router",
    place: g.derive("place", () => place),
    settings: { image: "oven/bun:1-slim", startCommand: "bun run", sleepApplication: false },
    ports: [8080],
    variables: async () => ({ ACHQ_REF: ref }),
    secretDigests: async () => [],
  };
  const added = addService(g, railway, spec);
  addDeployment(g, railway, spec, added);
  return { g, added };
};

test("an image service redeploys only when its config changed, and keeps exactly one public domain", async () => {
  const first = imageService("a");
  expect((await first.g.plan()).changes.map(formatChange)).toEqual([
    "+ service achq-router",
    "? achq-router private hostname (after service achq-router)",
    "? achq-router volume (after service achq-router)",
    "? achq-router public domains (after service achq-router)",
    "? achq-router variables (after service achq-router)",
    "? achq-router deploy (after service achq-router)",
  ]);
  const applied = await first.g.apply();
  expect(domainFor(applied.output(first.added.domains)!, 8080)).toBe("achq-router-production.up.railway.app");
  expect(fake.service("achq-router")!.deployments).toHaveLength(1);

  expect((await imageService("a").g.plan()).changes).toEqual([]);

  const changed = imageService("b");
  expect((await changed.g.plan()).changes.map(formatChange)).toEqual(["~ achq-router variables ACHQ_REF", "+ achq-router deploy"]);
  fake.service("achq-router")!.domains.push({ id: "dom-x", domain: "stray.up.railway.app", targetPort: 3000 });
  await changed.g.apply();
  expect(fake.service("achq-router")!.deployments).toHaveLength(2);
  expect(fake.service("achq-router")!.domains.map((d) => d.targetPort)).toEqual([8080]);
});

test("a secret found somewhere older moves into shared variables, and a given one follows its giver", async () => {
  const legacy = async (name: string) => (name === "KEY" ? "old-key" : undefined);
  const run = (token: string) => {
    const g = graph();
    const store = sharedVariables(railway, place, legacy);
    g.add("secret KEY", secret, { store, name: "KEY", location: "store", ...generated(() => "new-key") });
    g.add("secret TOKEN", secret, { store, name: "TOKEN", location: "store", ...given(token) });
    return g;
  };

  expect((await run("t1").plan()).changes.map(formatChange)).toEqual(["~ secret KEY location", "+ secret TOKEN"]);
  await run("t1").apply();
  expect(fake.project("achq")!.shared).toEqual({ KEY: "old-key", TOKEN: "t1" });

  expect((await run("t1").plan()).changes).toEqual([]);
  await run("t2").apply();
  expect(fake.project("achq")!.shared).toEqual({ KEY: "old-key", TOKEN: "t2" });
});
