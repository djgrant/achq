import { expect, test } from "bun:test";
import { achq, type Deployer, type Router } from "@achq/core";
import * as railway from "../src/resources.ts";
import { railwayPlatform } from "../src/runtime/platform.ts";

const declare = (routerProject: string, deployerProject: string) => {
  const { resources } = achq(() => {
    const router = new railway.Router("router", { project: routerProject });
    new railway.Deployer("deployer", { project: deployerProject, router, owners: [] });
  })();
  return { router: resources[0] as Router, deployer: resources[1] as Deployer };
};

test("the router and deployer must share one Railway project", () => {
  expect(() => railwayPlatform.infra(declare("achq", "other"), { RAILWAY_API_TOKEN: "t" })).toThrow("share one Railway project");
  expect(() => railwayPlatform.infra(declare("achq", "achq"), { RAILWAY_API_TOKEN: "t" })).not.toThrow();
});

test("the infra needs a Railway token, and the deployer's container host its project too", () => {
  expect(() => railwayPlatform.infra(declare("achq", "achq"), {})).toThrow("Missing RAILWAY_API_TOKEN");
  expect(() => railwayPlatform.containerHost({ RAILWAY_API_TOKEN: "t" })).toThrow("Missing ACHQ_RAILWAY_PROJECT_ID");
});
