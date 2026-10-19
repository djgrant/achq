import { expect, test } from "bun:test";
import { resetDeclarations } from "@achq/core";
import { Service } from "../src/lib/service.ts";

test("a service's comparison is pure: it takes what was read and says what differs", () => {
  resetDeclarations();
  const service = new Service("service", { at: { projectId: "p", environmentId: "e" }, name: "achq-router", settings: {}, volume: "/data" });
  const props = { at: { projectId: "p", environmentId: "e" }, name: "achq-router", settings: { source: { image: "bun" }, sleepApplication: false }, volume: "/data", publicPort: 8080 };
  const current = {
    serviceId: "s",
    // Connected to a repo, which Railway records on the source: not a difference.
    instance: { source: { image: "bun", repo: "o/r" }, sleepApplication: null, latestDeployment: null },
    volumes: ["/data"],
    endpoint: { id: "ep", privateNetworkId: "pn", dnsName: "old-name" },
    domains: [
      { id: "d1", domain: "keep.up.railway.app", targetPort: 8080 },
      { id: "d2", domain: "stale.up.railway.app", targetPort: 3000 },
    ],
    autoDeploy: false,
  };
  const changes = service.diff(props, current);
  expect(changes.map((c) => service.describe(c, props))).toEqual([
    { op: "~", target: "achq-router settings", detail: "sleepApplication" },
    { op: "~", target: "achq-router private hostname", detail: "old-name → achq-router" },
    { op: "-", target: "achq-router public domain", detail: "stale.up.railway.app" },
  ]);
  expect(service.planned(props, current, changes)).toEqual({ serviceId: "s", url: "https://keep.up.railway.app" });
});

test("a service asked for its env gives its variables as read, none if it doesn't exist yet, and applying doesn't change them", () => {
  resetDeclarations();
  const at = { projectId: "p", environmentId: "e" };
  const service = new Service("service", { at, name: "achq-router", settings: {}, volume: "/data", env: true });
  const props = { at, name: "achq-router", settings: {}, volume: "/data", env: true as const };
  expect(service.planned(props, undefined, service.diff(props, undefined))).toEqual({ serviceId: expect.anything(), url: undefined, env: {} });
  const current = { serviceId: "s", instance: { latestDeployment: null }, volumes: ["/data"], domains: [], autoDeploy: false, env: { PORT: "8080" } };
  expect(service.planned(props, current, service.diff(props, current)).env).toEqual({ PORT: "8080" });
  const { env: _, ...withoutEnv } = props;
  expect(service.planned(withoutEnv, current, [])).toEqual({ serviceId: "s", url: undefined });
});
