import { afterEach, beforeEach, expect, test } from "bun:test";
import { RailwayClient } from "../src/api.ts";
import { type FakeRailway, startFakeRailway } from "@achq/test-utils/railway";
import { planService } from "../src/runtime/plan.ts";
import { routerServiceSpec } from "../src/runtime/specs.ts";

let fake: FakeRailway;

beforeEach(async () => {
  fake = startFakeRailway();
  await new RailwayClient("t", fake.url).createProject("achq", "ws");
  fake.mutations.length = 0;
});
afterEach(() => fake.stop());

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
